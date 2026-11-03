import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
} from '@nestjs/common';
import {
  DOCUMENT_STORE,
  StoreError,
  isValidId,
  type DocumentList,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';
import { describeProblem } from './problem-text';

export const NOT_FOUND_MESSAGE = 'There is no saved analysis with this id.';

// The answer when a saved analysis could not be deleted. The reason is only in
// the log of the server, because it can hold a path.
export const DELETE_FAILED_MESSAGE =
  'The saved analysis could not be deleted. The reason is in the log of the server.';

// Reads the analyses that were saved, and deletes one on request (see
// document-store.ts).
@Controller('documents')
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(@Inject(DOCUMENT_STORE) private readonly store: DocumentStore) {}

  // The list for a history page: the newest analyses first, without the clauses.
  @Get()
  async list(): Promise<DocumentList> {
    const result = await this.store.list();
    if (result.unreadable > 0) {
      this.logger.warn(
        `${result.unreadable} saved file(s) could not be read, so they are not in the list.`,
      );
    }
    return result;
  }

  // One saved analysis, as POST /analyze returned it, with its id and the time
  // it was saved.
  @Get(':id')
  async get(@Param('id') id: string): Promise<SavedAnalysis> {
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

  // Deletes one saved analysis, for good: the file cannot be brought back.
  // Only the analysis with this id is deleted. There is no address that deletes
  // all of them: DELETE /documents is not found. The answer is 204 with no body.
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    let removed: boolean;
    try {
      removed = await this.store.delete(id);
    } catch (error) {
      // The store only throws for an id of the right form. The log gets the
      // kind of the error and its code, never its message, because that holds
      // a path.
      const shown = isValidId(id) ? id : '(an id of the wrong form)';
      this.logger.warn(
        `The saved analysis ${shown} could not be deleted: ${describeProblem(error)}`,
      );
      throw new InternalServerErrorException(DELETE_FAILED_MESSAGE);
    }
    if (removed === false) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }
  }
}
