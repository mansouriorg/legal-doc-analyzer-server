import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { AiRequestCancelledError } from './ai-analyzer';
import type { AiSettingsResult } from './ai-settings';
import {
  AI_SETTINGS,
  ANALYZE_TOOLS,
  type AnalyzeTools,
} from './analyze-document';
import { toHttpException } from './analyze-errors';
import { watchClient, type WatchedResponse } from './client-gone';
import {
  answerQuestion,
  readAskRequest,
  type AskResponse,
} from './document-chat';
import {
  DOCUMENT_STORE,
  StoreError,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';
import { NOT_FOUND_MESSAGE } from './documents.controller';

// The answer for a question whose browser has left. Nobody receives it, because
// the connection is closed. The code 499 is the one that servers such as nginx
// use for this ("client closed request"). Only a test can see it.
export const CLIENT_LEFT_STATUS = 499;
export const CLIENT_LEFT_MESSAGE =
  'The browser stopped waiting, so the question was cancelled.';

// Answers a question about a saved analysis with the AI service (see
// document-chat.ts). Its address starts like the one of the saved analyses,
// /documents/:id, but it is its own controller because it needs the AI service.
@Controller('documents')
export class AskController {
  private readonly logger = new Logger(AskController.name);

  constructor(
    @Inject(AI_SETTINGS) private readonly ai: AiSettingsResult,
    @Inject(ANALYZE_TOOLS) private readonly tools: AnalyzeTools,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
  ) {}

  // The body is { "question": "...", "history": [{ "role": "user" or "ai",
  // "content": "..." }] } and the answer is { "answer": "..." }.
  // 400: the body is not right. 404: there is no saved analysis with this id.
  // 503, 504 and 502: the AI service cannot be used, is too slow, or answered
  // with something unusable (the same as POST /analyze).
  // The browser can leave before the answer is ready: the person clicked "Stop
  // waiting", closed the tab or left the page. Then the call to the AI service
  // is cancelled too, so that a model on this computer is not kept busy with a
  // question that nobody waits for (see client-gone.ts). The answer is then a
  // 499, which nobody receives.
  @Post(':id/ask')
  @HttpCode(HttpStatus.OK)
  async ask(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response?: WatchedResponse,
  ): Promise<AskResponse> {
    const request = readAskRequest(body);
    if (typeof request === 'string') {
      throw new BadRequestException(request);
    }

    const analysis = await this.load(id);
    const watch = watchClient(response);
    try {
      const answer = await answerQuestion({
        ai: this.ai,
        analysis,
        question: request.question,
        history: request.history,
        fetchImpl: this.tools.fetchImpl,
        cancel: watch.signal,
      });
      return { answer };
    } catch (error) {
      if (error instanceof AiRequestCancelledError) {
        // A fixed line. It never has the question, the answer or anything of
        // the document.
        this.logger.log(CLIENT_LEFT_MESSAGE);
        throw new HttpException(CLIENT_LEFT_MESSAGE, CLIENT_LEFT_STATUS);
      }
      const problem = toHttpException(error);
      if (problem === null) {
        // Not an error that was expected. Nest answers 500 and logs it.
        throw error;
      }
      // The log gets the problems of the AI service, with a fixed message. It
      // never gets the question, the answer or anything of the document.
      if (problem.getStatus() >= 500 && error instanceof Error) {
        this.logger.warn(`${error.name}: ${error.message}`);
      }
      throw problem;
    } finally {
      watch.stop();
    }
  }

  // The saved analysis, as GET /documents/:id reads it.
  private async load(id: string): Promise<SavedAnalysis> {
    let found: SavedAnalysis | null;
    try {
      found = await this.store.get(id);
    } catch (error) {
      if (error instanceof StoreError) {
        // The store only throws this for an id of the right form, so the id is
        // safe to write in the log. The message never has the text of a file.
        this.logger.warn(`The saved analysis ${id}: ${error.message}`);
        throw new InternalServerErrorException(error.message);
      }
      // Not an error that was expected. Nest answers 500 and logs it.
      throw error;
    }
    if (found === null) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
    return found;
  }
}
