import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AiRequestCancelledError, type AnalysisResult } from './ai-analyzer';
import type { AiSettingsResult } from './ai-settings';
import {
  AI_SETTINGS,
  ANALYZE_TOOLS,
  analyzeDocument,
  type AnalyzeTools,
} from './analyze-document';
import { toHttpException } from './analyze-errors';
import { CLIENT_LEFT_STATUS } from './ask.controller';
import { watchClient, type WatchedResponse } from './client-gone';
import {
  DOCUMENT_STORE,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';
import { repairFileName } from './file-name';
import { describeProblem } from './problem-text';
import {
  decideSaving,
  SAVE_SETTING,
  type SaveDecision,
  type SaveSetting,
} from './save-setting';
import {
  MAX_UPLOAD_BYTES,
  validateUpload,
  type UploadedDocument,
} from './upload-rules';

// Said to the person when the analysis was made, but it could not be saved.
export const SAVE_FAILED_NOTE =
  'This analysis could not be saved on the server, so it will not be in the list of saved analyses.';

// The answer for an analysis whose browser has left, and the one line that the
// log gets. Nobody receives the answer, because the connection is closed (see
// CLIENT_LEFT_STATUS in ask.controller.ts). The message never has the name or
// the text of the document.
export const ANALYSIS_CANCELLED_MESSAGE =
  'The browser stopped waiting, so the analysis was cancelled.';

// The answer of POST /analyze: the analysis. When it was saved, it also has the
// id and the time of saving, the same fields as GET /documents/:id.
export type AnalyzeResponse = AnalysisResult &
  Partial<Pick<SavedAnalysis, 'id' | 'savedAt'>>;

// The value of the form field "save" of the request, or undefined when it has
// none. The body of an upload holds its text fields.
function readSaveField(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'save' in body) {
    return (body as { save?: unknown }).save;
  }
  return undefined;
}

@Controller('analyze')
export class AnalyzeController {
  private readonly logger = new Logger(AnalyzeController.name);

  constructor(
    @Inject(AI_SETTINGS) private readonly ai: AiSettingsResult,
    @Inject(ANALYZE_TOOLS) private readonly tools: AnalyzeTools,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(SAVE_SETTING) private readonly saving: SaveSetting,
  ) {}

  // The client sends one file in the form field "document". The form field
  // "save" with the value false asks for no saving (see save-setting.ts).
  // The browser can leave before the analysis is ready: the person closed the
  // tab or left the page. Then the call to the AI service is cancelled and
  // nothing is saved (see client-gone.ts). The answer is then a 499, which
  // nobody receives.
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('document', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async analyze(
    @UploadedFile() upload: UploadedDocument | undefined,
    @Body() body?: unknown,
    @Res({ passthrough: true }) response?: WatchedResponse,
  ): Promise<AnalyzeResponse> {
    if (upload === undefined) {
      throw new BadRequestException(
        'No file was received. Send one file in the form field "document".',
      );
    }

    const file = {
      ...upload,
      originalname: repairFileName(upload.originalname),
    };
    const problem = validateUpload(file);
    if (problem !== null) {
      throw new BadRequestException(problem);
    }
    const decision = decideSaving(this.saving, readSaveField(body));

    const watch = watchClient(response);
    let analysis: AnalysisResult;
    try {
      analysis = await analyzeDocument(file, this.ai, this.tools, watch.signal);
    } catch (error) {
      if (error instanceof AiRequestCancelledError) {
        // A fixed line. It never has the name or the text of the document.
        this.logger.log(ANALYSIS_CANCELLED_MESSAGE);
        throw new HttpException(ANALYSIS_CANCELLED_MESSAGE, CLIENT_LEFT_STATUS);
      }
      const answer = toHttpException(error);
      if (answer === null) {
        // Not an error that was expected. Nest answers 500 and logs it.
        throw error;
      }
      // The person gets the message. The log gets the problems that are not
      // the fault of the file, so that whoever runs the server can see them.
      // It never gets the name or the text of the document.
      if (answer.getStatus() >= 500 && error instanceof Error) {
        this.logger.warn(`${error.name}: ${error.message}`);
      }
      throw answer;
    } finally {
      watch.stop();
    }
    return this.keep(analysis, decision);
  }

  // Saves the analysis. A problem with saving does not take the analysis away
  // from the person: they get it without an id and with a note, and the log
  // gets one line.
  private async keep(
    analysis: AnalysisResult,
    decision: SaveDecision,
  ): Promise<AnalyzeResponse> {
    if (decision.save === false) {
      // Nothing is written, not even the data folder. The person gets the
      // analysis without an id, and a note that says why.
      return { ...analysis, notes: [...analysis.notes, decision.note] };
    }
    try {
      return await this.store.save(analysis);
    } catch (error) {
      this.logger.warn(
        `The analysis was made, but it could not be saved: ${describeProblem(error)}`,
      );
      return { ...analysis, notes: [...analysis.notes, SAVE_FAILED_NOTE] };
    }
  }
}
