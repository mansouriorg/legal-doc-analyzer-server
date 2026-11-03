import { HttpException, Logger } from '@nestjs/common';
import { makeDocx, paragraph } from '../test/helpers/make-docx';
import type { AiSettings, AiSettingsResult } from './ai-settings';
import type { AnalyzeTools } from './analyze-document';
import { AnalyzeController, SAVE_FAILED_NOTE } from './analyze.controller';
import {
  NOT_SAVED_MESSAGE,
  StoreError,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';
import { ExtractionError, type ExtractedText } from './extraction';
import {
  NOT_KEPT_NOTE,
  SAVE_FIELD_UNCLEAR_NOTE,
  SAVING_OFF_NOTE,
  type SaveSetting,
} from './save-setting';
import type { TextReaders } from './text-extractor';
import type { UploadedDocument } from './upload-rules';

const settings: AiSettings = {
  baseUrl: 'https://api.example.com/v1',
  model: 'small-model',
  apiKey: null,
  timeoutMs: 5000,
  maxInputChars: 30000,
};
const configured: AiSettingsResult = { settings, problems: [] };

const contract = [
  '1. Term. This agreement starts on 1 January and renews automatically each year unless a party gives 90 days written notice.',
  '2. Liability. The supplier is liable for any damage without any limit, including indirect damage and lost profit.',
].join('\n');

const goodAnswer = JSON.stringify({
  choices: [
    {
      message: {
        role: 'assistant',
        content: JSON.stringify({
          summary: 'A short contract about term and liability.',
          clauses: [
            {
              title: 'Liability',
              quote: 'liable for any damage without any limit',
              risk: 'high',
              explanation: 'There is no cap on the damage.',
            },
          ],
        }),
      },
    },
  ],
});

type Reply = { status: number; body: string } | Error;

// A fetch that always gives the same reply.
function fakeFetch(reply: Reply): typeof fetch {
  const impl = (): Promise<Response> => {
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(reply.body),
    } as Response);
  };
  return impl as unknown as typeof fetch;
}

function fakeReaders(result: ExtractedText | Error): TextReaders {
  const answer = (): ExtractedText => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return {
    pdf: () => Promise.resolve().then(answer),
    docx: answer,
  };
}

function toolsFor(reply: Reply, readers?: TextReaders): AnalyzeTools {
  return { fetchImpl: fakeFetch(reply), readers };
}

function file(name: string, buffer: Buffer): UploadedDocument {
  return { originalname: name, size: buffer.length, buffer };
}

const wordFile = makeDocx(
  contract
    .split('\n')
    .map((line) => paragraph(line))
    .join(''),
);
const pdfFile = Buffer.from('%PDF-1.7\n%%EOF');
const oldWordFile = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
]);

const SAVED_AT = '2026-10-25T16:30:00.000Z';

// A store that keeps the analyses in memory. `saved` is what it was asked to save.
function memoryStore(): { store: DocumentStore; saved: SavedAnalysis[] } {
  const saved: SavedAnalysis[] = [];
  const store: DocumentStore = {
    save: (analysis) => {
      const entry: SavedAnalysis = {
        id: `00000000-0000-4000-8000-${String(saved.length + 1).padStart(12, '0')}`,
        savedAt: SAVED_AT,
        ...analysis,
      };
      saved.push(entry);
      return Promise.resolve(entry);
    },
    get: (id) => Promise.resolve(saved.find((item) => item.id === id) ?? null),
    list: () =>
      Promise.resolve({ documents: [], total: saved.length, unreadable: 0 }),
    // POST /analyze never deletes.
    delete: () => Promise.reject(new Error('delete was not expected')),
  };
  return { store, saved };
}

// A store whose save always fails with the given error.
function failingStore(error: Error): DocumentStore {
  return {
    save: () => Promise.reject(error),
    get: () => Promise.resolve(null),
    list: () => Promise.resolve({ documents: [], total: 0, unreadable: 0 }),
    delete: () => Promise.reject(new Error('delete was not expected')),
  };
}

const savingOn: SaveSetting = { enabled: true, problem: null };

function controllerFor(
  ai: AiSettingsResult,
  tools: AnalyzeTools,
  store: DocumentStore = memoryStore().store,
  saving: SaveSetting = savingOn,
): AnalyzeController {
  return new AnalyzeController(ai, tools, store, saving);
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

describe('AnalyzeController', () => {
  let warn: ReturnType<typeof silenceWarnings>;

  beforeEach(() => {
    warn = silenceWarnings();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('the upload', () => {
    const controller = controllerFor(configured, {});

    it('answers 400 when no file was received', async () => {
      const error = await httpFailure(controller.analyze(undefined));
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('No file was received');
    });

    it('answers 400 for a file of another kind', async () => {
      const error = await httpFailure(
        controller.analyze(file('notes.txt', Buffer.from('hello'))),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('not a PDF or Word document');
    });

    it('answers 400 for an empty file', async () => {
      const error = await httpFailure(
        controller.analyze(file('empty.pdf', Buffer.alloc(0))),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('is empty');
    });

    it('answers 400 for a .pdf that is really text', async () => {
      const error = await httpFailure(
        controller.analyze(file('fake.pdf', Buffer.from('just text'))),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('does not look like a real .pdf file');
    });

    it('does not write anything in the log for these answers', async () => {
      await httpFailure(controller.analyze(undefined));
      await httpFailure(
        controller.analyze(file('notes.txt', Buffer.from('hello'))),
      );
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('shows the right name of a file in a message when multer read it as Latin-1', async () => {
      const right = `soci${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}.txt`;
      const wrong = Buffer.from(right, 'utf8').toString('latin1');
      const error = await httpFailure(
        controller.analyze(file(wrong, Buffer.from('hello'))),
      );
      expect(error.message).toContain(`"${right}"`);
    });
  });

  describe('a good file', () => {
    it('returns the analysis of a Word file', async () => {
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }),
      );
      const result = await controller.analyze(file('contract.docx', wordFile));
      expect(result.documentName).toBe('contract.docx');
      expect(result.executiveSummary).toBe(
        'A short contract about term and liability.',
      );
      expect(result.clauses).toHaveLength(1);
      expect(result.clauses[0].riskLevel).toBe('High');
      expect(result.notes).toEqual([]);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('returns the analysis of a PDF, with the notes of the reader', async () => {
      const readers = fakeReaders({
        text: contract,
        notes: ['Only the first 300 of 400 pages were read.'],
      });
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
      );
      const result = await controller.analyze(file('contract.pdf', pdfFile));
      expect(result.clauses).toHaveLength(1);
      expect(result.notes).toEqual([
        'Only the first 300 of 400 pages were read.',
      ]);
    });

    it('returns the right name of the file when multer read it as Latin-1', async () => {
      const right = `contrat-soci${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}.docx`;
      const wrong = Buffer.from(right, 'utf8').toString('latin1');
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }),
      );
      const result = await controller.analyze(file(wrong, wordFile));
      expect(result.documentName).toBe(right);
    });
  });

  describe('a file that cannot be used', () => {
    const controller = controllerFor(
      configured,
      toolsFor({ status: 200, body: goodAnswer }),
    );

    it('answers 415 for an old .doc file', async () => {
      const error = await httpFailure(
        controller.analyze(file('old.doc', oldWordFile)),
      );
      expect(error.getStatus()).toBe(415);
      expect(error.message).toContain('old Word file (.doc)');
    });

    it('answers 422 for a .docx file that is not a real one', async () => {
      const zipStart = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      const error = await httpFailure(
        controller.analyze(file('fake.docx', zipStart)),
      );
      expect(error.getStatus()).toBe(422);
    });

    it('answers 422 with the message for a PDF that needs a password', async () => {
      const readers = fakeReaders(
        new ExtractionError('password-protected', 'The PDF has a password.'),
      );
      const locked = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
      );
      const error = await httpFailure(
        locked.analyze(file('locked.pdf', pdfFile)),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.message).toBe('The PDF has a password.');
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('answers 422 for a document without text, such as a scan', async () => {
      const readers = fakeReaders({ text: '', notes: [] });
      const scanned = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
      );
      const error = await httpFailure(
        scanned.analyze(file('scan.pdf', pdfFile)),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.message).toContain('no readable text');
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  describe('the AI service cannot be used', () => {
    it('answers 503 when no AI service is set up, and logs it', async () => {
      const controller = controllerFor({ settings: null, problems: [] }, {});
      const error = await httpFailure(
        controller.analyze(file('contract.docx', wordFile)),
      );
      expect(error.getStatus()).toBe(503);
      expect(error.message).toContain('not set up to analyze documents');
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).toContain('AiServiceError');
    });

    it('answers 503 when the settings are not valid', async () => {
      const controller = controllerFor(
        { settings: null, problems: ['AI_MODEL is missing.'] },
        {},
      );
      const error = await httpFailure(
        controller.analyze(file('contract.docx', wordFile)),
      );
      expect(error.getStatus()).toBe(503);
      expect(error.message).toContain('not valid');
    });

    const cases: Array<[string, Reply, number, string]> = [
      [
        'it cannot be reached',
        new TypeError('fetch failed'),
        503,
        'could not be reached',
      ],
      [
        'it does not answer in time',
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
        504,
        'did not answer within',
      ],
      ['it has an error', { status: 500, body: 'oops' }, 502, 'had an error'],
      [
        'it does not accept the key',
        { status: 401, body: 'no' },
        502,
        'did not accept the key',
      ],
      [
        'it does not know the model',
        { status: 404, body: 'no' },
        502,
        'does not know the model',
      ],
      [
        'it says there are too many requests',
        { status: 429, body: 'slow' },
        503,
        'too many requests',
      ],
      [
        'its answer is not data',
        { status: 200, body: 'not json' },
        502,
        'not with the expected data',
      ],
    ];
    for (const [name, reply, status, text] of cases) {
      it(`answers ${status} when ${name}, and logs it`, async () => {
        const controller = controllerFor(configured, toolsFor(reply));
        const error = await httpFailure(
          controller.analyze(file('contract.docx', wordFile)),
        );
        expect(error.getStatus()).toBe(status);
        expect(error.message).toContain(text);
        expect(warn.mock.calls).toHaveLength(1);
        expect(String(warn.mock.calls[0][0])).toContain(text);
      });
    }

    it('never writes the name of the file in the log', async () => {
      const controller = controllerFor(
        configured,
        toolsFor({ status: 500, body: 'oops' }),
      );
      await httpFailure(
        controller.analyze(file('secret-divorce.docx', wordFile)),
      );
      expect(String(warn.mock.calls[0][0])).not.toContain('secret-divorce');
    });
  });

  describe('a problem that was not expected', () => {
    it('is passed on unchanged, so that Nest answers 500, and is not written by this controller', async () => {
      const problem = new Error('The PDF reader could not be loaded.');
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, fakeReaders(problem)),
      );
      const error = await failure(
        controller.analyze(file('contract.pdf', pdfFile)),
      );
      expect(error).toBe(problem);
      expect(error instanceof HttpException).toBe(false);
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  describe('saving the analysis', () => {
    it('saves the analysis and returns it with its id and the time of saving', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }),
        store,
      );
      const result = await controller.analyze(file('contract.docx', wordFile));
      expect(saved).toHaveLength(1);
      expect(result.id).toBe(saved[0].id);
      expect(result.savedAt).toBe(SAVED_AT);
      expect(result.documentName).toBe('contract.docx');
      expect(result.clauses).toHaveLength(1);
      expect(result).toEqual(saved[0]);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('saves the notes of the reader with the analysis', async () => {
      const readers = fakeReaders({
        text: contract,
        notes: ['Only the first 300 of 400 pages were read.'],
      });
      const { store, saved } = memoryStore();
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
        store,
      );
      const result = await controller.analyze(file('contract.pdf', pdfFile));
      expect(saved).toHaveLength(1);
      expect(saved[0].notes).toEqual([
        'Only the first 300 of 400 pages were read.',
      ]);
      expect(result.notes).toEqual(saved[0].notes);
    });

    it('saves the right name of a file that multer read as Latin-1', async () => {
      const right = `contrat-soci${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}.docx`;
      const wrong = Buffer.from(right, 'utf8').toString('latin1');
      const { store, saved } = memoryStore();
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }),
        store,
      );
      await controller.analyze(file(wrong, wordFile));
      expect(saved).toHaveLength(1);
      expect(saved[0].documentName).toBe(right);
    });

    it('saves each analysis under its own id', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }),
        store,
      );
      const first = await controller.analyze(file('one.docx', wordFile));
      const second = await controller.analyze(file('two.docx', wordFile));
      expect(saved).toHaveLength(2);
      expect(first.id).not.toBe(second.id);
      expect(saved[0].documentName).toBe('one.docx');
      expect(saved[1].documentName).toBe('two.docx');
    });

    const refused: Array<
      [string, AiSettingsResult, AnalyzeTools, UploadedDocument | undefined]
    > = [
      ['no file', configured, {}, undefined],
      [
        'a file of another kind',
        configured,
        {},
        file('notes.txt', Buffer.from('hello')),
      ],
      ['an old .doc file', configured, {}, file('old.doc', oldWordFile)],
      [
        'a .docx file that is not a real one',
        configured,
        {},
        file('fake.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])),
      ],
      [
        'a document without text',
        configured,
        toolsFor(
          { status: 200, body: goodAnswer },
          fakeReaders({ text: '', notes: [] }),
        ),
        file('scan.pdf', pdfFile),
      ],
      [
        'an AI service that is not set up',
        { settings: null, problems: [] },
        {},
        file('contract.docx', wordFile),
      ],
      [
        'an AI service that has an error',
        configured,
        toolsFor({ status: 500, body: 'oops' }),
        file('contract.docx', wordFile),
      ],
      [
        'a problem that was not expected',
        configured,
        toolsFor(
          { status: 200, body: goodAnswer },
          fakeReaders(new Error('The PDF reader could not be loaded.')),
        ),
        file('contract.pdf', pdfFile),
      ],
    ];
    for (const [name, ai, tools, upload] of refused) {
      it(`saves nothing for ${name}`, async () => {
        const { store, saved } = memoryStore();
        await failure(controllerFor(ai, tools, store).analyze(upload));
        expect(saved).toHaveLength(0);
      });
    }
  });

  describe('an analysis that cannot be saved', () => {
    const goodTools = toolsFor({ status: 200, body: goodAnswer });
    // An error of the file system: its message holds a path.
    const noRight = Object.assign(
      new Error("EACCES: permission denied, mkdir '/private/place/data'"),
      { code: 'EACCES' },
    );

    it('still returns the analysis, with no id and no time, and a note', async () => {
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(noRight),
      );
      const result = await controller.analyze(file('contract.docx', wordFile));
      expect(result.id).toBeUndefined();
      expect(result.savedAt).toBeUndefined();
      expect('id' in result).toBe(false);
      expect('savedAt' in result).toBe(false);
      expect(result.documentName).toBe('contract.docx');
      expect(result.executiveSummary).toBe(
        'A short contract about term and liability.',
      );
      expect(result.clauses).toHaveLength(1);
      expect(result.notes).toEqual([SAVE_FAILED_NOTE]);
    });

    it('puts the note after the notes of the reader', async () => {
      const readers = fakeReaders({
        text: contract,
        notes: ['Only the first 300 of 400 pages were read.'],
      });
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
        failingStore(noRight),
      );
      const result = await controller.analyze(file('contract.pdf', pdfFile));
      expect(result.notes).toEqual([
        'Only the first 300 of 400 pages were read.',
        SAVE_FAILED_NOTE,
      ]);
    });

    it('writes one warning with the kind and the code of the error, but not its message, the name of the file or its text', async () => {
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(noRight),
      );
      await controller.analyze(file('secret-divorce.docx', wordFile));
      expect(warn.mock.calls).toHaveLength(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('could not be saved');
      expect(line).toContain('Error EACCES');
      expect(line).not.toContain('/private/place');
      expect(line).not.toContain('secret-divorce');
      expect(line).not.toContain('liable for any damage');
      expect(line).not.toContain('A short contract about term and liability');
    });

    it('writes the fixed message of an error of the store', async () => {
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(new StoreError(NOT_SAVED_MESSAGE)),
      );
      const result = await controller.analyze(file('contract.docx', wordFile));
      expect(result.notes).toEqual([SAVE_FAILED_NOTE]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).toContain(NOT_SAVED_MESSAGE);
    });

    it('writes only the kind of an error that has no code', async () => {
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(new TypeError('private detail')),
      );
      await controller.analyze(file('contract.docx', wordFile));
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('TypeError');
      expect(line).not.toContain('private detail');
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('null');
    });

    it('does not write a code that does not look like the code of a system error', async () => {
      const odd = Object.assign(new Error('x'), {
        code: 'C:\\Users\\me\\secret',
      });
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(odd),
      );
      await controller.analyze(file('contract.docx', wordFile));
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('Error');
      expect(line).not.toContain('Users');
      expect(line).not.toContain('secret');
    });

    it('writes nothing about a rejection that is not an error', async () => {
      // A value that is not an Error is not expected, but a library could do it.
      const notAnError = { message: 'private detail' } as unknown as Error;
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(notAnError),
      );
      const result = await controller.analyze(file('contract.docx', wordFile));
      expect(result.notes).toEqual([SAVE_FAILED_NOTE]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('private detail');
    });

    it('saves the next analysis normally after one that could not be saved', async () => {
      const { store, saved } = memoryStore();
      let failed = false;
      const flaky: DocumentStore = {
        ...store,
        save: (analysis) => {
          if (failed === false) {
            failed = true;
            return Promise.reject(noRight);
          }
          return store.save(analysis);
        },
      };
      const controller = controllerFor(configured, goodTools, flaky);
      const first = await controller.analyze(file('one.docx', wordFile));
      const second = await controller.analyze(file('two.docx', wordFile));
      expect(first.id).toBeUndefined();
      expect(second.id).toBe(saved[0].id);
      expect(second.notes).toEqual([]);
      expect(saved).toHaveLength(1);
    });
  });
  describe('turning saving off', () => {
    const goodTools = toolsFor({ status: 200, body: goodAnswer });
    const upload = (): UploadedDocument => file('contract.docx', wordFile);

    // The text fields of an upload are in the body of the request.
    it('saves when the request has no field and the setting is on', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store);
      const result = await controller.analyze(upload());
      expect(result.id).toBe(saved[0].id);
      expect(result.notes).toEqual([]);
    });

    it('saves when the field "save" says true', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store);
      const result = await controller.analyze(upload(), { save: 'true' });
      expect(result.id).toBe(saved[0].id);
      expect(result.notes).toEqual([]);
    });

    it('does not save when the field says false, and still returns the analysis with a note', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store);
      const result = await controller.analyze(upload(), { save: 'false' });
      expect(saved).toHaveLength(0);
      expect('id' in result).toBe(false);
      expect('savedAt' in result).toBe(false);
      expect(result.documentName).toBe('contract.docx');
      expect(result.executiveSummary).toBe(
        'A short contract about term and liability.',
      );
      expect(result.clauses).toHaveLength(1);
      expect(result.notes).toEqual([NOT_KEPT_NOTE]);
    });

    it('does not save when the field is not understood, and says so', async () => {
      for (const value of ['maybe', '', ['false'], ['true', 'false']]) {
        const { store, saved } = memoryStore();
        const controller = controllerFor(configured, goodTools, store);
        const result = await controller.analyze(upload(), { save: value });
        expect(saved).toHaveLength(0);
        expect(result.notes).toEqual([SAVE_FIELD_UNCLEAR_NOTE]);
      }
    });

    it('does not save when the setting is off, also when the field says true', async () => {
      for (const body of [undefined, {}, { save: 'true' }, { save: 'false' }]) {
        const { store, saved } = memoryStore();
        const controller = controllerFor(configured, goodTools, store, {
          enabled: false,
          problem: null,
        });
        const result = await controller.analyze(upload(), body);
        expect(saved).toHaveLength(0);
        expect('id' in result).toBe(false);
        expect(result.notes).toEqual([SAVING_OFF_NOTE]);
      }
    });

    it('does not save when the setting was not understood', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store, {
        enabled: false,
        problem: 'SAVE_ANALYSES is not true or false, so no analysis is saved.',
      });
      const result = await controller.analyze(upload(), { save: 'true' });
      expect(saved).toHaveLength(0);
      expect(result.notes).toEqual([SAVING_OFF_NOTE]);
    });

    it('puts the note after the notes of the reader', async () => {
      const readers = fakeReaders({
        text: contract,
        notes: ['Only the first 300 of 400 pages were read.'],
      });
      const controller = controllerFor(
        configured,
        toolsFor({ status: 200, body: goodAnswer }, readers),
      );
      const result = await controller.analyze(file('contract.pdf', pdfFile), {
        save: 'false',
      });
      expect(result.notes).toEqual([
        'Only the first 300 of 400 pages were read.',
        NOT_KEPT_NOTE,
      ]);
    });

    it('does not touch the store when it does not save, so nothing is written and nothing is logged', async () => {
      const controller = controllerFor(
        configured,
        goodTools,
        failingStore(new Error('save was not expected')),
      );
      const result = await controller.analyze(file('secret.docx', wordFile), {
        save: 'false',
      });
      expect(result.notes).toEqual([NOT_KEPT_NOTE]);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('ignores a body that is not an object, and other fields', async () => {
      for (const body of [
        null,
        'save=false',
        5,
        ['save'],
        { other: 'false' },
      ]) {
        const { store, saved } = memoryStore();
        const controller = controllerFor(configured, goodTools, store);
        const result = await controller.analyze(upload(), body);
        expect(saved).toHaveLength(1);
        expect(result.id).toBe(saved[0].id);
      }
    });

    it('saves the next analysis normally after one that was not saved', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store);
      const first = await controller.analyze(upload(), { save: 'false' });
      const second = await controller.analyze(upload());
      expect(first.id).toBeUndefined();
      expect(second.id).toBe(saved[0].id);
      expect(saved).toHaveLength(1);
    });

    it('does not save a file that is refused, whatever the field says', async () => {
      const { store, saved } = memoryStore();
      const controller = controllerFor(configured, goodTools, store);
      await failure(
        controller.analyze(file('notes.txt', Buffer.from('hello')), {
          save: 'true',
        }),
      );
      expect(saved).toHaveLength(0);
    });
  });
});
