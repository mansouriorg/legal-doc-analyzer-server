import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AnalysisResult } from './../src/ai-analyzer';
import type { AiSettingsResult } from './../src/ai-settings';
import {
  AI_SETTINGS,
  ANALYZE_TOOLS,
  type AnalyzeTools,
} from './../src/analyze-document';
import { SAVE_FAILED_NOTE } from './../src/analyze.controller';
import { AppModule } from './../src/app.module';
import { DEFAULT_CLIENT_ORIGIN, configureApp } from './../src/app.setup';
import {
  DOCUMENT_STORE,
  FileDocumentStore,
  isValidId,
  type DocumentList,
  type SavedAnalysis,
} from './../src/document-store';
import {
  NOT_KEPT_NOTE,
  SAVE_FIELD_UNCLEAR_NOTE,
  SAVE_SETTING,
  SAVING_OFF_NOTE,
  type SaveSetting,
} from './../src/save-setting';
import { MAX_UPLOAD_BYTES } from './../src/upload-rules';
import { makeDocx, paragraph } from './helpers/make-docx';
import { makeTempDir, removeTempDir } from './helpers/temp-dir';

const contract = [
  '1. Term. This agreement starts on 1 January and renews automatically each year unless a party gives 90 days written notice.',
  '2. Liability. The supplier is liable for any damage without any limit, including indirect damage and lost profit.',
].join('\n');

const wordFile = makeDocx(
  contract
    .split('\n')
    .map((line) => paragraph(line))
    .join(''),
);
const emptyWordFile = makeDocx('');
const pdfFile = Buffer.from('%PDF-1.7\n%%EOF');
const oldWordFile = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
]);

// What the AI service answers: one clause that is in the contract.
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

const notSetUp: AiSettingsResult = { settings: null, problems: [] };

function settingsFor(baseUrl: string, timeoutMs = 5000): AiSettingsResult {
  return {
    settings: {
      baseUrl,
      model: 'small-model',
      apiKey: null,
      timeoutMs,
      maxInputChars: 30000,
    },
    problems: [],
  };
}

// A small AI service on this computer, so that the real fetch is used.
interface FakeAi {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startFakeAi(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<FakeAi> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// Answers every request with the given status and body, and remembers what it was sent.
function answerWith(status: number, body: string, seen: string[] = []) {
  return (incoming: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push(Buffer.concat(chunks).toString());
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  };
}

describe('POST /analyze (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let fakeAi: FakeAi | undefined;
  // A folder of the test for the saved analyses, inside .tmp-tests. The server
  // of a test never writes into the real data folder.
  let dataRoot = '';
  let dataDir = '';

  beforeEach(async () => {
    dataRoot = await makeTempDir();
    dataDir = join(dataRoot, 'data');
  });

  // Starts the whole server with the given AI settings and tools, and saves the
  // analyses in the folder of the test.
  async function launch(
    ai: AiSettingsResult,
    tools: AnalyzeTools = {},
    saving: SaveSetting = { enabled: true, problem: null },
  ): Promise<App> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AI_SETTINGS)
      .useValue(ai)
      .overrideProvider(ANALYZE_TOOLS)
      .useValue(tools)
      .overrideProvider(DOCUMENT_STORE)
      .useValue(new FileDocumentStore(dataDir))
      .overrideProvider(SAVE_SETTING)
      .useValue(saving)
      .compile();

    const created: INestApplication<App> =
      moduleFixture.createNestApplication();
    // The log would only repeat what the tests check.
    created.useLogger(false);
    // An empty environment, so the test does not depend on your shell settings.
    configureApp(created, {});
    await created.init();
    app = created;
    return created.getHttpServer();
  }

  async function launchWithFakeAi(
    status: number,
    body: string,
    seen: string[] = [],
  ): Promise<App> {
    fakeAi = await startFakeAi(answerWith(status, body, seen));
    return launch(settingsFor(fakeAi.baseUrl));
  }

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    if (fakeAi !== undefined) {
      await fakeAi.close();
      fakeAi = undefined;
    }
    await removeTempDir(dataRoot);
  });

  it('answers 400 when no file is sent', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .expect(400)
      .expect(/No file was received/);
  });

  it('answers 400 for a text file, and the client page may read the answer (CORS)', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .attach('document', Buffer.from('hello'), 'notes.txt')
      .expect(400)
      .expect(/not a PDF or Word document/)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers 400 for a .pdf that is really text', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .attach('document', Buffer.from('just text'), 'fake.pdf')
      .expect(400)
      .expect(/does not look like a real \.pdf file/);
  });

  it('answers 400 when the file is sent in another form field', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .attach('file', pdfFile, 'contract.pdf')
      .expect(400);
  });

  it('answers 413 for a file over 10 MB, and the client page may read the answer (CORS)', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .attach('document', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x25), 'big.pdf')
      .expect(413)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers 503 for a good file when no AI service is set up, and the client page may read the answer (CORS)', async () => {
    const server = await launch(notSetUp);
    return request(server)
      .post('/analyze')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .attach('document', pdfFile, 'contract.pdf')
      .expect(503)
      .expect(/not set up to analyze documents/)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers 503 for a good file when the AI settings are not valid', async () => {
    const server = await launch({
      settings: null,
      problems: ['AI_MODEL is missing.'],
    });
    return request(server)
      .post('/analyze')
      .attach('document', pdfFile, 'contract.pdf')
      .expect(503)
      .expect(/settings of the AI service are not valid/);
  });

  it('answers 200 with the analysis of a Word file, and the client page may read it (CORS)', async () => {
    const seen: string[] = [];
    const server = await launchWithFakeAi(200, goodAnswer, seen);
    const response = await request(server)
      .post('/analyze')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .attach('document', wordFile, 'contract.docx')
      .expect(200)
      .expect('Content-Type', /json/)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);

    const body = response.body as AnalysisResult;
    expect(body.documentName).toBe('contract.docx');
    expect(body.executiveSummary).toBe(
      'A short contract about term and liability.',
    );
    expect(body.clauses).toHaveLength(1);
    expect(body.clauses[0].title).toBe('Liability');
    expect(body.clauses[0].riskLevel).toBe('High');
    expect(body.clauses[0].originalText).toBe(
      'liable for any damage without any limit',
    );
    expect(body.notes).toEqual([]);

    // The AI service got the text of the Word file.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('renews automatically each year');
  });

  it('answers 200 with the analysis of a PDF, and passes on the notes of the reader', async () => {
    const seen: string[] = [];
    fakeAi = await startFakeAi(answerWith(200, goodAnswer, seen));
    const server = await launch(settingsFor(fakeAi.baseUrl), {
      readers: {
        // The real PDF reader cannot be loaded by Jest, so a fake one is used here.
        pdf: () =>
          Promise.resolve({
            text: contract,
            notes: ['Only the first 2 of 5 pages were read.'],
          }),
        docx: () => ({ text: '', notes: [] }),
      },
    });
    const response = await request(server)
      .post('/analyze')
      .attach('document', pdfFile, 'contract.pdf')
      .expect(200);

    const body = response.body as AnalysisResult;
    expect(body.documentName).toBe('contract.pdf');
    expect(body.clauses).toHaveLength(1);
    expect(body.notes).toEqual(['Only the first 2 of 5 pages were read.']);
    expect(seen[0]).toContain('liable for any damage without any limit');
  });

  it('returns the name of a file with accents as it was sent', async () => {
    const name = `contrat-soci${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}.docx`;
    const server = await launchWithFakeAi(200, goodAnswer);
    const response = await request(server)
      .post('/analyze')
      .attach('document', wordFile, name)
      .expect(200);

    expect((response.body as AnalysisResult).documentName).toBe(name);
  });

  it('answers 415 for an old .doc file', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    return request(server)
      .post('/analyze')
      .attach('document', oldWordFile, 'old.doc')
      .expect(415)
      .expect(/old Word file \(\.doc\)/);
  });

  it('answers 422 for a .docx file that is not a real one', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    const zipStart = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    return request(server)
      .post('/analyze')
      .attach('document', zipStart, 'fake.docx')
      .expect(422);
  });

  it('answers 422 for a document without text', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    return request(server)
      .post('/analyze')
      .attach('document', emptyWordFile, 'empty.docx')
      .expect(422)
      .expect(/no readable text/);
  });

  it('answers 503 when the AI service cannot be reached', async () => {
    const closed = await startFakeAi(() => undefined);
    await closed.close();
    const server = await launch(settingsFor(closed.baseUrl));
    return request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(503)
      .expect(/could not be reached/);
  });

  it('answers 504 when the AI service does not answer in time', async () => {
    fakeAi = await startFakeAi(() => {
      // never answers
    });
    const server = await launch(settingsFor(fakeAi.baseUrl, 200));
    return request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(504)
      .expect(/did not answer within/);
  });

  it('answers 502 when the AI service has an error', async () => {
    const server = await launchWithFakeAi(500, 'oops');
    return request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(502)
      .expect(/had an error/);
  });

  it('answers 500 without details when something unexpected goes wrong', async () => {
    const server = await launch(settingsFor('http://127.0.0.1:9/v1'), {
      readers: {
        pdf: () => Promise.reject(new Error('secret internal detail')),
        docx: () => ({ text: '', notes: [] }),
      },
    });
    const response = await request(server)
      .post('/analyze')
      .attach('document', pdfFile, 'contract.pdf')
      .expect(500);

    expect(response.text).not.toContain('secret internal detail');
  });

  // Uploads a Word file that is analyzed and saved, and gives the answer.
  async function postWord(
    server: App,
    name = 'contract.docx',
  ): Promise<SavedAnalysis> {
    const response = await request(server)
      .post('/analyze')
      .attach('document', wordFile, name)
      .expect(200);
    return response.body as SavedAnalysis;
  }

  it('saves the analysis in a file, and answers with its id and the time of saving', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    const body = await postWord(server);

    expect(isValidId(body.id)).toBe(true);
    expect(new Date(body.savedAt).toISOString()).toBe(body.savedAt);
    expect(body.documentName).toBe('contract.docx');
    expect(body.clauses).toHaveLength(1);
    expect(body.notes).toEqual([]);

    // One file, named after the id, with the same content as the answer.
    expect(await readdir(dataDir)).toEqual([`${body.id}.json`]);
    const text = await readFile(join(dataDir, `${body.id}.json`), 'utf8');
    expect(JSON.parse(text) as unknown).toEqual(body);
  });

  it('can read the saved analysis back with GET /documents/:id and GET /documents', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    const body = await postWord(server, 'lease.docx');

    const one = await request(server).get(`/documents/${body.id}`).expect(200);
    expect(one.body).toEqual(body);

    const listed = await request(server).get('/documents').expect(200);
    const list = listed.body as DocumentList;
    expect(list.total).toBe(1);
    expect(list.documents).toEqual([
      {
        id: body.id,
        documentName: 'lease.docx',
        savedAt: body.savedAt,
        clauseCount: 1,
        highRisks: 1,
        mediumRisks: 0,
        lowRisks: 0,
      },
    ]);
  });

  it('gives each analysis its own id and its own file', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    const first = await postWord(server, 'one.docx');
    const second = await postWord(server, 'two.docx');

    expect(first.id).not.toBe(second.id);
    const files = await readdir(dataDir);
    expect(files.sort()).toEqual(
      [`${first.id}.json`, `${second.id}.json`].sort(),
    );
    const listed = await request(server).get('/documents').expect(200);
    expect((listed.body as DocumentList).total).toBe(2);
  });

  it('saves nothing for a file that is refused', async () => {
    const server = await launchWithFakeAi(200, goodAnswer);
    await request(server)
      .post('/analyze')
      .attach('document', Buffer.from('hello'), 'notes.txt')
      .expect(400);
    await request(server)
      .post('/analyze')
      .attach('document', oldWordFile, 'old.doc')
      .expect(415);
    await request(server)
      .post('/analyze')
      .attach('document', emptyWordFile, 'empty.docx')
      .expect(422);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('saves nothing when the AI service has an error', async () => {
    const server = await launchWithFakeAi(500, 'oops');
    await request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(502);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('answers 200 with the analysis and a note when it cannot be saved, and saves again when the problem is gone', async () => {
    // A file where the folder should be, so the folder cannot be made.
    await writeFile(dataDir, 'in the way');
    const server = await launchWithFakeAi(200, goodAnswer);
    const response = await request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(200);

    const body = response.body as AnalysisResult;
    expect('id' in body).toBe(false);
    expect('savedAt' in body).toBe(false);
    expect(body.documentName).toBe('contract.docx');
    expect(body.clauses).toHaveLength(1);
    expect(body.notes).toEqual([SAVE_FAILED_NOTE]);
    expect(response.text).not.toContain(dataRoot);

    await rm(dataDir);
    const again = await postWord(server);
    expect(isValidId(again.id)).toBe(true);
    expect(again.notes).toEqual([]);
    expect(await readdir(dataDir)).toEqual([`${again.id}.json`]);
  });
  describe('turning saving off', () => {
    const off: SaveSetting = { enabled: false, problem: null };

    // Uploads a Word file with the given text fields, and gives the answer.
    async function postWordWith(
      server: App,
      fields: Record<string, string>,
    ): Promise<AnalysisResult> {
      let sending = request(server).post('/analyze');
      for (const [name, value] of Object.entries(fields)) {
        sending = sending.field(name, value);
      }
      const response = await sending
        .attach('document', wordFile, 'contract.docx')
        .expect(200);
      return response.body as AnalysisResult;
    }

    async function expectNothingSaved(server: App): Promise<void> {
      // Not even the folder was made.
      expect(existsSync(dataDir)).toBe(false);
      const listed = await request(server).get('/documents').expect(200);
      expect((listed.body as DocumentList).total).toBe(0);
    }

    it('saves nothing when the form field save is false, and still answers with the analysis and a note', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const body = await postWordWith(server, { save: 'false' });

      expect('id' in body).toBe(false);
      expect('savedAt' in body).toBe(false);
      expect(body.documentName).toBe('contract.docx');
      expect(body.executiveSummary).toBe(
        'A short contract about term and liability.',
      );
      expect(body.clauses).toHaveLength(1);
      expect(body.notes).toEqual([NOT_KEPT_NOTE]);
      await expectNothingSaved(server);
    });

    it('does the same when the field comes after the file', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const response = await request(server)
        .post('/analyze')
        .attach('document', wordFile, 'contract.docx')
        .field('save', 'false')
        .expect(200);

      const body = response.body as AnalysisResult;
      expect('id' in body).toBe(false);
      expect(body.notes).toEqual([NOT_KEPT_NOTE]);
      await expectNothingSaved(server);
    });

    it('saves as before when the field is true', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const body = (await postWordWith(server, {
        save: 'true',
      })) as SavedAnalysis;

      expect(isValidId(body.id)).toBe(true);
      expect(body.notes).toEqual([]);
      expect(await readdir(dataDir)).toEqual([`${body.id}.json`]);
    });

    it('saves nothing when the field is not true or false, and says so', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const body = await postWordWith(server, { save: 'maybe' });

      expect('id' in body).toBe(false);
      expect(body.notes).toEqual([SAVE_FIELD_UNCLEAR_NOTE]);
      await expectNothingSaved(server);
    });

    it('saves nothing when the field is sent twice', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const response = await request(server)
        .post('/analyze')
        .field('save', 'true')
        .field('save', 'false')
        .attach('document', wordFile, 'contract.docx')
        .expect(200);

      // The package that reads the upload makes a list of a name that comes
      // twice, so the field is not understood. Either way, nothing is saved.
      const body = response.body as AnalysisResult;
      expect('id' in body).toBe(false);
      expect(body.notes).toHaveLength(1);
      expect([NOT_KEPT_NOTE, SAVE_FIELD_UNCLEAR_NOTE]).toContain(body.notes[0]);
      await expectNothingSaved(server);
    });

    it('saves nothing when the setting of the server is off, also when the field says true', async () => {
      fakeAi = await startFakeAi(answerWith(200, goodAnswer));
      const server = await launch(settingsFor(fakeAi.baseUrl), {}, off);

      const requests: Record<string, string>[] = [
        {},
        { save: 'true' },
        { save: 'false' },
      ];
      for (const fields of requests) {
        const body = await postWordWith(server, fields);
        expect('id' in body).toBe(false);
        expect('savedAt' in body).toBe(false);
        expect(body.clauses).toHaveLength(1);
        expect(body.notes).toEqual([SAVING_OFF_NOTE]);
      }
      await expectNothingSaved(server);
    });

    it('leaves the folder of the test empty, with no temporary file, when it does not save', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      await postWordWith(server, { save: 'false' });
      expect(existsSync(dataRoot)).toBe(true);
      expect(await readdir(dataRoot)).toEqual([]);
    });

    it('keeps the analyses that are already saved when saving is turned off, and they can still be read and deleted', async () => {
      fakeAi = await startFakeAi(answerWith(200, goodAnswer));
      const first = await launch(settingsFor(fakeAi.baseUrl));
      const saved = await postWord(first, 'before.docx');
      await app?.close();
      app = undefined;

      const server = await launch(settingsFor(fakeAi.baseUrl), {}, off);
      const read = await request(server)
        .get(`/documents/${saved.id}`)
        .expect(200);
      expect(read.body).toEqual(saved);
      const listed = await request(server).get('/documents').expect(200);
      expect((listed.body as DocumentList).total).toBe(1);

      const again = await postWordWith(server, {});
      expect('id' in again).toBe(false);
      expect(await readdir(dataDir)).toEqual([`${saved.id}.json`]);

      await request(server).delete(`/documents/${saved.id}`).expect(204);
      expect(await readdir(dataDir)).toEqual([]);
    });

    it('cannot ask a question about an analysis that was not saved', async () => {
      const server = await launchWithFakeAi(200, goodAnswer);
      const body = await postWordWith(server, { save: 'false' });
      expect('id' in body).toBe(false);
      await request(server)
        .post('/documents/00000000-0000-4000-8000-000000000001/ask')
        .send({ question: 'Who pays?' })
        .expect(404);
    });
  });
});

describe('The settings of the AI service (e2e)', () => {
  const KEYS = ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY'] as const;

  it('come from the environment when a test does not give its own', async () => {
    const saved = KEYS.map((key) => process.env[key]);
    process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.AI_MODEL = 'env-model';
    process.env.AI_API_KEY = '';
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const ai = moduleFixture.get<AiSettingsResult>(AI_SETTINGS);
      expect(ai.problems).toEqual([]);
      expect(ai.settings?.model).toBe('env-model');
      expect(ai.settings?.baseUrl).toBe('http://127.0.0.1:9/v1');
      expect(moduleFixture.get<AnalyzeTools>(ANALYZE_TOOLS)).toEqual({});
    } finally {
      KEYS.forEach((key, index) => {
        const value = saved[index];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });
});
