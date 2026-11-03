import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer, request as sendRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AiSettingsResult } from './../src/ai-settings';
import { AI_SETTINGS, ANALYZE_TOOLS } from './../src/analyze-document';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { DOCUMENT_STORE, FileDocumentStore } from './../src/document-store';
import { SAVE_SETTING } from './../src/save-setting';
import { makeDocx, paragraph } from './helpers/make-docx';
import { makeTempDir, removeTempDir } from './helpers/temp-dir';

// What happens when the browser drops POST /analyze before the analysis is
// ready: the server drops its own request to the AI service and saves nothing.
// A real connection is needed for that, so these tests start the server on a
// free port and drop the connection from the outside.

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

const WORD_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

function settingsFor(baseUrl: string): AiSettingsResult {
  return {
    settings: {
      baseUrl,
      model: 'small-model',
      apiKey: null,
      timeoutMs: 5000,
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

async function waitUntil(done: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && done() === false) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return done();
}

// The body of an upload of one file in the form field "document", written by
// hand so that the test can send it on a connection that it can drop.
function multipartBody(boundary: string, name: string, content: Buffer) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${name}"\r\n` +
      `Content-Type: ${WORD_TYPE}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, content, tail]);
}

describe('POST /analyze: the browser drops the request (e2e)', () => {
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

  // Starts the whole server on a free port, with the given AI settings, and
  // saves the analyses in the folder of the test.
  async function launchListening(ai: AiSettingsResult) {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AI_SETTINGS)
      .useValue(ai)
      .overrideProvider(ANALYZE_TOOLS)
      .useValue({})
      .overrideProvider(DOCUMENT_STORE)
      .useValue(new FileDocumentStore(dataDir))
      .overrideProvider(SAVE_SETTING)
      .useValue({ enabled: true, problem: null })
      .compile();

    const created: INestApplication<App> =
      moduleFixture.createNestApplication();
    // The log would only repeat what the tests check.
    created.useLogger(false);
    // An empty environment, so the test does not depend on your shell settings.
    configureApp(created, {});
    await created.init();
    await created.listen(0, '127.0.0.1');
    app = created;
    const listening = created.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    return { server: created.getHttpServer(), port: listening.address().port };
  }

  it('drops its own request to the AI service, saves nothing, and answers the next upload', async () => {
    let asked = 0;
    let closedBeforeAnswer = 0;
    // The first request is never answered. The next ones are answered at once.
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
          response.end(goodAnswer);
        }
      });
      incoming.resume();
    });
    const { server, port } = await launchListening(settingsFor(fakeAi.baseUrl));

    const boundary = 'analyze-cancel-test-boundary';
    const body = multipartBody(boundary, 'contract.docx', wordFile);
    const outgoing = sendRequest({
      host: '127.0.0.1',
      port,
      path: '/analyze',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
      },
    });
    outgoing.on('error', () => undefined);
    outgoing.end(body);

    // The server has read the file and waits for the AI service.
    expect(await waitUntil(() => asked === 1)).toBe(true);
    expect(closedBeforeAnswer).toBe(0);
    outgoing.destroy();
    expect(await waitUntil(() => closedBeforeAnswer === 1)).toBe(true);

    // Nothing was saved: the data folder was not even made.
    expect(existsSync(dataDir)).toBe(false);

    // The server goes on: the next upload is analyzed and saved.
    const next = await request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(200);
    expect(typeof (next.body as { id?: unknown }).id).toBe('string');
    expect(asked).toBe(2);
    expect(closedBeforeAnswer).toBe(1);
    expect(await readdir(dataDir)).toHaveLength(1);
  });

  it('does not make the AI service wait for an upload that is dropped before the AI service is asked', async () => {
    let asked = 0;
    fakeAi = await startFakeAi((incoming, response) => {
      asked += 1;
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(goodAnswer);
      });
      incoming.resume();
    });
    const { server, port } = await launchListening(settingsFor(fakeAi.baseUrl));

    // Half of an upload is sent, and then the connection is dropped.
    const boundary = 'analyze-cancel-test-boundary';
    const body = multipartBody(boundary, 'contract.docx', wordFile);
    const outgoing = sendRequest({
      host: '127.0.0.1',
      port,
      path: '/analyze',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
      },
    });
    outgoing.on('error', () => undefined);
    outgoing.write(body.subarray(0, Math.floor(body.length / 2)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    outgoing.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(asked).toBe(0);
    expect(existsSync(dataDir)).toBe(false);

    // The server goes on.
    await request(server)
      .post('/analyze')
      .attach('document', wordFile, 'contract.docx')
      .expect(200);
    expect(asked).toBe(1);
  });
});
