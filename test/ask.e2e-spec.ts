import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as sendRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AnalysisResult, ChatMessage } from './../src/ai-analyzer';
import type { AiSettingsResult } from './../src/ai-settings';
import { AI_SETTINGS } from './../src/analyze-document';
import { DEFAULT_CLIENT_ORIGIN, configureApp } from './../src/app.setup';
import {
  ASK_INVALID_SETTINGS_MESSAGE,
  ASK_NOT_SET_UP_MESSAGE,
} from './../src/document-chat';
import {
  DAMAGED_MESSAGE,
  DOCUMENT_STORE,
  FileDocumentStore,
  type SavedAnalysis,
} from './../src/document-store';
import { AppModule } from './../src/app.module';
import { makeTempDir, removeTempDir } from './helpers/temp-dir';

const OTHER_ID = '123e4567-e89b-42d3-a456-426614174000';

const analysis: AnalysisResult = {
  documentName: 'secret-divorce.docx',
  executiveSummary: 'A short contract about term and liability.',
  clauses: [
    {
      id: 'clause-1',
      title: 'Term',
      originalText: 'renews automatically each year',
      riskLevel: 'Low',
      explanation: 'The agreement renews on its own.',
    },
    {
      id: 'clause-2',
      title: 'Liability',
      originalText: 'liable for any damage without any limit',
      riskLevel: 'High',
      explanation: 'There is no cap on the damage.',
    },
  ],
  notes: ['Only the beginning of the document was analyzed.'],
};

// What the AI service answers: plain text, as a chat API does.
function chatAnswer(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
}

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

interface Seen {
  url: string;
  body: string;
}

async function waitUntil(done: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && done() === false) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return done();
}

// Answers every request with the given status and body, and remembers what it was sent.
function answerWith(status: number, body: string, seen: Seen[] = []) {
  return (incoming: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({
        url: incoming.url ?? '',
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  };
}

function messagesIn(seen: Seen): ChatMessage[] {
  return (JSON.parse(seen.body) as { messages: ChatMessage[] }).messages;
}

describe('POST /documents/:id/ask (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let fakeAi: FakeAi | undefined;
  // A folder of the test for the saved analyses, inside .tmp-tests. The server
  // of a test never writes into the real data folder.
  let root = '';
  let dir = '';
  let store: FileDocumentStore;
  let saved: SavedAnalysis;

  beforeEach(async () => {
    root = await makeTempDir();
    dir = join(root, 'data');
    store = new FileDocumentStore(dir);
    saved = await store.save(analysis);
  });

  // Starts the whole server with the given AI settings. It reads the analyses
  // from the folder of the test.
  async function launch(ai: AiSettingsResult): Promise<App> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AI_SETTINGS)
      .useValue(ai)
      .overrideProvider(DOCUMENT_STORE)
      .useValue(store)
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
    seen: Seen[] = [],
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
    await removeTempDir(root);
  });

  it('answers 200 with { answer }, and the AI service gets the analysis and the question as plain text', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(
      200,
      chatAnswer('The supplier has no limit on damage.'),
      seen,
    );
    const response = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'Who pays for damage?' })
      .expect(200);

    expect(response.body).toEqual({
      answer: 'The supplier has no limit on damage.',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/chat/completions');
    const body = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
    expect(body.temperature).toBe(0);
    const messages = messagesIn(seen[0]);
    expect(messages.map((item) => item.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[1].content).toContain('liable for any damage');
    expect(messages[1].content).toContain('Liability');
    expect(messages[3].content).toBe('Who pays for damage?');
    expect(seen[0].body).not.toContain('secret-divorce');
  });

  it('sends the earlier messages on, with the role assistant for the answers', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({
        question: 'And the fee?',
        history: [
          { id: 'welcome-msg', role: 'ai', content: 'What would you like?' },
          { id: '1', role: 'user', content: 'What is the term?' },
          { id: '2', role: 'ai', content: 'It renews each year.' },
        ],
      })
      .expect(200);

    const messages = messagesIn(seen[0]);
    expect(messages.map((item) => item.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[3].content).toBe('What is the term?');
    expect(messages[4].content).toBe('It renews each year.');
    expect(messages[5].content).toBe('And the fee?');
    expect(seen[0].body).not.toContain('What would you like?');
    expect(seen[0].body).not.toContain('welcome-msg');
  });

  it('changes nothing in the saved analyses', async () => {
    const file = join(dir, `${saved.id}.json`);
    const before = await readFile(file, 'utf8');
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'));
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(200);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(dir)).toEqual([`${saved.id}.json`]);
  });

  it('lets the client page send the request and read the answer (CORS)', async () => {
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'));
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .send({ question: 'What is the term?' })
      .expect(200)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers the browser pre-check (OPTIONS) for the client page, allows POST, and asks the AI service nothing', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    const response = await request(server)
      .options(`/documents/${saved.id}/ask`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
    expect(String(response.headers['access-control-allow-methods'])).toContain(
      'POST',
    );
    expect(seen).toHaveLength(0);
  });

  it('does not allow other pages to send it (CORS)', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    const response = await request(server)
      .options(`/documents/${saved.id}/ask`)
      .set('Origin', 'http://other.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('answers 400 for a body that is not right, and asks the AI service nothing', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    const path = `/documents/${saved.id}/ask`;

    // Without a JSON body there is no body at all (or an empty one), and the
    // message says what to send.
    const noBody = await request(server).post(path).expect(400);
    expect((noBody.body as { message: string }).message).toMatch(
      /Send a JSON object|The question is missing/,
    );
    const notJson = await request(server)
      .post(path)
      .type('text/plain')
      .send('What is the term?')
      .expect(400);
    expect((notJson.body as { message: string }).message).toMatch(
      /Send a JSON object|The question is missing/,
    );
    await request(server)
      .post(path)
      .type('application/json')
      .send('{"question": ')
      .expect(400);
    await request(server).post(path).send({}).expect(400);
    await request(server).post(path).send({ question: '   ' }).expect(400);
    const badRole = await request(server)
      .post(path)
      .send({ question: 'Q', history: [{ role: 'system', content: 'x' }] })
      .expect(400);
    expect((badRole.body as { message: string }).message).toContain(
      'needs the role "user" or "ai"',
    );
    await request(server)
      .post(path)
      .send({ question: 'q'.repeat(1001) })
      .expect(400)
      .expect(/too long/);
    expect(seen).toHaveLength(0);
  });

  it('answers 404 for an id that is not saved, and asks the AI service nothing', async () => {
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    const response = await request(server)
      .post(`/documents/${OTHER_ID}/ask`)
      .send({ question: 'What is the term?' })
      .expect(404);
    expect((response.body as { message: string }).message).toBe(
      'There is no saved analysis with this id.',
    );
    expect(seen).toHaveLength(0);
  });

  it('answers 404 for an address that is not the id the server made, and reads no other file', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, 'outside.json'), '{"keep": "me"}');
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    for (const path of [
      'abc',
      '*',
      `${saved.id}.json`,
      saved.id.toUpperCase(),
      `..%2Foutside`,
      `..%2F..%2Foutside`,
      `..%2Fdata%2F${saved.id}`,
    ]) {
      await request(server)
        .post(`/documents/${path}/ask`)
        .send({ question: 'What is the term?' })
        .expect(404);
    }
    expect(seen).toHaveLength(0);
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe(
      '{"keep": "me"}',
    );
  });

  it('has no other address for it: GET and POST on the analysis itself are not found', async () => {
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'));
    await request(server).get(`/documents/${saved.id}/ask`).expect(404);
    await request(server)
      .post(`/documents/${saved.id}`)
      .send({ question: 'Q' })
      .expect(404);
    await request(server)
      .post('/documents/ask')
      .send({ question: 'Q' })
      .expect(404);
  });

  it('answers 500 with the fixed message when the saved file is damaged, without its content', async () => {
    const file = join(dir, `${saved.id}.json`);
    await writeFile(file, '{"documentName": "secret-divorce.docx", broken');
    const seen: Seen[] = [];
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'), seen);
    const response = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(500);
    expect((response.body as { message: string }).message).toBe(
      DAMAGED_MESSAGE,
    );
    expect(response.text).not.toContain('secret-divorce');
    expect(seen).toHaveLength(0);
  });

  it('answers 503 when no AI service is set up', async () => {
    const server = await launch(notSetUp);
    const response = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .send({ question: 'What is the term?' })
      .expect(503)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
    expect((response.body as { message: string }).message).toBe(
      ASK_NOT_SET_UP_MESSAGE,
    );
  });

  it('answers 503 when the settings of the AI service are not valid', async () => {
    const server = await launch({
      settings: null,
      problems: ['AI_MODEL is missing.'],
    });
    const response = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(503);
    expect((response.body as { message: string }).message).toBe(
      ASK_INVALID_SETTINGS_MESSAGE,
    );
  });

  it('answers 503 when the AI service cannot be reached', async () => {
    const closed = await startFakeAi(() => undefined);
    await closed.close();
    const server = await launch(settingsFor(closed.baseUrl));
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(503)
      .expect(/could not be reached/);
  });

  it('answers 503 when the AI service says there are too many requests', async () => {
    const server = await launchWithFakeAi(429, 'slow down');
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(503)
      .expect(/too many requests/);
  });

  it('answers 504 when the AI service does not answer in time', async () => {
    fakeAi = await startFakeAi(() => {
      // never answers
    });
    const server = await launch(settingsFor(fakeAi.baseUrl, 200));
    await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(504)
      .expect(/did not answer within/);
  });

  it('answers 502 when the AI service has an error, or answers with something unusable', async () => {
    const failing = await launchWithFakeAi(500, 'oops');
    await request(failing)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(502)
      .expect(/had an error/);
    await app?.close();
    app = undefined;
    await fakeAi?.close();

    const empty = await launchWithFakeAi(200, chatAnswer('   '));
    await request(empty)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'What is the term?' })
      .expect(502)
      .expect(/the answer is empty/);
  });

  it('keeps the question, the answer of the service and the file name out of every error', async () => {
    const server = await launchWithFakeAi(
      500,
      'a secret answer of the service',
    );
    const response = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'a very private question' })
      .expect(502);
    for (const text of ['secret', 'private', 'divorce', 'Liability']) {
      expect(response.text).not.toContain(text);
    }
  });

  it('does not make the data folder when there is no saved analysis', async () => {
    const empty = join(root, 'empty');
    store = new FileDocumentStore(empty);
    const server = await launchWithFakeAi(200, chatAnswer('Fine.'));
    await request(server)
      .post(`/documents/${OTHER_ID}/ask`)
      .send({ question: 'What is the term?' })
      .expect(404);
    expect(existsSync(empty)).toBe(false);
  });

  it('drops its own request to the AI service when the browser drops its request, and answers the next question', async () => {
    let asked = 0;
    let closedBeforeAnswer = 0;
    // The first question is never answered. The next ones are answered at once.
    fakeAi = await startFakeAi((incoming, response) => {
      asked += 1;
      const answerNow = asked > 1;
      response.on('close', () => {
        if (response.writableFinished === false) {
          closedBeforeAnswer += 1;
        }
      });
      incoming.on('end', () => {
        if (answerNow) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(chatAnswer('Fine.'));
        }
      });
      incoming.resume();
    });
    const server = await launch(settingsFor(fakeAi.baseUrl));
    // A real connection is needed, so that the browser can drop it.
    const running = app;
    if (running === undefined) {
      throw new Error('the server did not start');
    }
    await running.listen(0, '127.0.0.1');
    const listening = running.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    const port = listening.address().port;

    const body = JSON.stringify({ question: 'Who pays for damage?' });
    const outgoing = sendRequest({
      host: '127.0.0.1',
      port,
      path: `/documents/${saved.id}/ask`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    outgoing.on('error', () => undefined);
    outgoing.end(body);

    expect(await waitUntil(() => asked === 1)).toBe(true);
    expect(closedBeforeAnswer).toBe(0);
    outgoing.destroy();
    expect(await waitUntil(() => closedBeforeAnswer === 1)).toBe(true);

    const next = await request(server)
      .post(`/documents/${saved.id}/ask`)
      .send({ question: 'And the fee?' })
      .expect(200);
    expect(next.body).toEqual({ answer: 'Fine.' });
    expect(asked).toBe(2);
    expect(closedBeforeAnswer).toBe(1);
  });
});
