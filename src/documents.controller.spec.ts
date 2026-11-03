import { HttpException, Logger } from '@nestjs/common';
import type { AnalysisResult } from './ai-analyzer';
import {
  DAMAGED_MESSAGE,
  StoreError,
  type DocumentList,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';
import {
  DELETE_FAILED_MESSAGE,
  DocumentsController,
} from './documents.controller';

const ID = '123e4567-e89b-42d3-a456-426614174000';

const saved: SavedAnalysis = {
  id: ID,
  savedAt: '2026-10-25T16:30:00.000Z',
  documentName: 'secret-divorce.docx',
  executiveSummary: 'A short contract about term and liability.',
  clauses: [
    {
      id: 'clause-1',
      title: 'Liability',
      originalText: 'liable for any damage without any limit',
      riskLevel: 'High',
      explanation: 'There is no cap on the damage.',
    },
  ],
  notes: [],
};

const emptyList: DocumentList = { documents: [], total: 0, unreadable: 0 };

// A store that gives the answers of the test. save() is not used by this controller.
function storeWith(answers: Partial<DocumentStore>): DocumentStore {
  return {
    save: (analysis: AnalysisResult) =>
      Promise.reject(
        new Error(`save was not expected: ${analysis.documentName}`),
      ),
    get: () => Promise.resolve(null),
    list: () => Promise.resolve(emptyList),
    delete: () => Promise.resolve(false),
    ...answers,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but nothing was thrown');
}

async function httpFailure(promise: Promise<unknown>): Promise<HttpException> {
  const error = await failure(promise);
  if (error instanceof HttpException) {
    return error;
  }
  throw new Error('expected an HttpException');
}

function silenceWarnings() {
  return jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

describe('DocumentsController', () => {
  let warn: ReturnType<typeof silenceWarnings>;

  beforeEach(() => {
    warn = silenceWarnings();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('list', () => {
    it('returns the list of the store', async () => {
      const list: DocumentList = {
        documents: [
          {
            id: ID,
            documentName: 'contract.docx',
            savedAt: saved.savedAt,
            clauseCount: 1,
            highRisks: 1,
            mediumRisks: 0,
            lowRisks: 0,
          },
        ],
        total: 1,
        unreadable: 0,
      };
      const controller = new DocumentsController(
        storeWith({ list: () => Promise.resolve(list) }),
      );
      expect(await controller.list()).toEqual(list);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('writes nothing in the log when every file could be read', async () => {
      const controller = new DocumentsController(storeWith({}));
      await controller.list();
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('warns, with the number of files and without any name, when some could not be read', async () => {
      const controller = new DocumentsController(
        storeWith({
          list: () =>
            Promise.resolve({ documents: [], total: 0, unreadable: 2 }),
        }),
      );
      const result = await controller.list();
      expect(result.unreadable).toBe(2);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).toContain('2 saved file(s)');
    });

    it('passes on an error of the store unchanged', async () => {
      const problem = new Error('EACCES: permission denied');
      const controller = new DocumentsController(
        storeWith({ list: () => Promise.reject(problem) }),
      );
      expect(await failure(controller.list())).toBe(problem);
    });
  });

  describe('get', () => {
    it('returns the saved analysis', async () => {
      const controller = new DocumentsController(
        storeWith({ get: () => Promise.resolve(saved) }),
      );
      expect(await controller.get(ID)).toEqual(saved);
    });

    it('asks the store for the id of the address', async () => {
      const asked: string[] = [];
      const controller = new DocumentsController(
        storeWith({
          get: (id: string) => {
            asked.push(id);
            return Promise.resolve(saved);
          },
        }),
      );
      await controller.get(ID);
      expect(asked).toEqual([ID]);
    });

    it('answers 404 when there is no analysis with this id', async () => {
      const controller = new DocumentsController(storeWith({}));
      const error = await httpFailure(controller.get(ID));
      expect(error.getStatus()).toBe(404);
      expect(error.message).toBe('There is no saved analysis with this id.');
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('answers 500 with a fixed message for a file that cannot be read, and logs the id', async () => {
      const controller = new DocumentsController(
        storeWith({
          get: () => Promise.reject(new StoreError(DAMAGED_MESSAGE)),
        }),
      );
      const error = await httpFailure(controller.get(ID));
      expect(error.getStatus()).toBe(500);
      expect(error.message).toBe(DAMAGED_MESSAGE);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).toContain(ID);
      expect(String(warn.mock.calls[0][0])).not.toContain('secret-divorce');
    });

    it('passes on any other error unchanged, so that Nest answers 500', async () => {
      const problem = new Error('EACCES: permission denied');
      const controller = new DocumentsController(
        storeWith({ get: () => Promise.reject(problem) }),
      );
      const error = await failure(controller.get(ID));
      expect(error).toBe(problem);
      expect(error instanceof HttpException).toBe(false);
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  describe('remove', () => {
    it('asks the store to delete the id of the address, and does nothing else', async () => {
      const calls: string[] = [];
      const controller = new DocumentsController({
        save: () => {
          calls.push('save');
          return Promise.reject(new Error('save was not expected'));
        },
        get: () => {
          calls.push('get');
          return Promise.resolve(null);
        },
        list: () => {
          calls.push('list');
          return Promise.resolve(emptyList);
        },
        delete: (id: string) => {
          calls.push(`delete ${id}`);
          return Promise.resolve(true);
        },
      });
      const result = await controller.remove(ID);
      expect(result).toBeUndefined();
      expect(calls).toEqual([`delete ${ID}`]);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('answers 404 when there is no analysis with this id', async () => {
      const controller = new DocumentsController(storeWith({}));
      const error = await httpFailure(controller.remove(ID));
      expect(error.getStatus()).toBe(404);
      expect(error.message).toBe('There is no saved analysis with this id.');
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('answers 500 with a fixed message when the file cannot be removed, and logs the id, the kind and the code', async () => {
      const noRight = Object.assign(
        new Error("EACCES: permission denied, unlink '/private/place/data/x'"),
        { code: 'EACCES' },
      );
      const controller = new DocumentsController(
        storeWith({ delete: () => Promise.reject(noRight) }),
      );
      const error = await httpFailure(controller.remove(ID));
      expect(error.getStatus()).toBe(500);
      expect(error.message).toBe(DELETE_FAILED_MESSAGE);
      expect(error.message).not.toContain('/private/place');
      expect(warn.mock.calls).toHaveLength(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(ID);
      expect(line).toContain('could not be deleted');
      expect(line).toContain('Error EACCES');
      expect(line).not.toContain('/private/place');
    });

    it('does not write an id of the wrong form in the log', async () => {
      const controller = new DocumentsController(
        storeWith({ delete: () => Promise.reject(new Error('x')) }),
      );
      const error = await httpFailure(
        controller.remove('../x\nfake line in the log'),
      );
      expect(error.getStatus()).toBe(500);
      expect(warn.mock.calls).toHaveLength(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).not.toContain('fake line');
      expect(line).not.toContain('../x');
    });
  });
});
