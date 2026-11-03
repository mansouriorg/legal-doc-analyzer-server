import { EventEmitter } from 'node:events';
import { HttpException, Logger } from '@nestjs/common';
import type { AiSettings, AiSettingsResult } from './ai-settings';
import type { AnalyzeTools } from './analyze-document';
import {
  AskController,
  CLIENT_LEFT_MESSAGE,
  CLIENT_LEFT_STATUS,
} from './ask.controller';
import type { WatchedResponse } from './client-gone';
import {
  ASK_INVALID_SETTINGS_MESSAGE,
  ASK_NOT_SET_UP_MESSAGE,
  MAX_QUESTION_CHARS,
} from './document-chat';
import {
  DAMAGED_MESSAGE,
  StoreError,
  type DocumentStore,
  type SavedAnalysis,
} from './document-store';

const ID = '123e4567-e89b-42d3-a456-426614174000';

const settings: AiSettings = {
  baseUrl: 'https://api.example.com/v1',
  model: 'small-model',
  apiKey: null,
  timeoutMs: 5000,
  maxInputChars: 30000,
};
const configured: AiSettingsResult = { settings, problems: [] };

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

const PRIVATE_QUESTION = 'What happens to my secret savings account?';

type Reply = { status: number; body: string } | Error;

interface Call {
  url: string;
  init: RequestInit;
}

// A fetch that always gives the same reply and remembers what it was asked.
function fakeFetch(reply: Reply) {
  const calls: Call[] = [];
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(reply.body),
    } as Response);
  };
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

function answerOf(content: string): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
    }),
  };
}

// A store that gives the answers of the test, and remembers the ids it was asked for.
function storeWith(answers: Partial<DocumentStore>) {
  const asked: string[] = [];
  const store: DocumentStore = {
    save: () => Promise.reject(new Error('save was not expected')),
    get: (id) => {
      asked.push(id);
      return Promise.resolve(null);
    },
    list: () => Promise.reject(new Error('list was not expected')),
    delete: () => Promise.reject(new Error('delete was not expected')),
    ...answers,
  };
  return { store, asked };
}

function makeController(options: {
  reply?: Reply;
  ai?: AiSettingsResult;
  found?: SavedAnalysis | null;
  store?: Partial<DocumentStore>;
}) {
  const fake = fakeFetch(options.reply ?? answerOf('An answer.'));
  const tools: AnalyzeTools = { fetchImpl: fake.fetchImpl };
  const { store, asked } = storeWith({
    get: (id) => {
      asked.push(id);
      return Promise.resolve(
        options.found === undefined ? saved : options.found,
      );
    },
    ...options.store,
  });
  const controller = new AskController(options.ai ?? configured, tools, store);
  return { controller, calls: fake.calls, asked };
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

function messageOf(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  return (response as { message: string }).message;
}

function silenceWarnings() {
  return jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

describe('AskController', () => {
  let warn: ReturnType<typeof silenceWarnings>;

  beforeEach(() => {
    warn = silenceWarnings();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('a good question', () => {
    it('answers with the text of the AI service, as { answer }', async () => {
      const { controller } = makeController({
        reply: answerOf('The supplier has no limit on damage.'),
      });
      expect(
        await controller.ask(ID, { question: 'Who pays for damage?' }),
      ).toEqual({ answer: 'The supplier has no limit on damage.' });
    });

    it('reads the saved analysis with the id of the address, and puts it and the question in the request', async () => {
      const { controller, calls, asked } = makeController({});
      await controller.ask(ID, { question: 'Who pays for damage?' });

      expect(asked).toEqual([ID]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
      const sent = calls[0].init.body as string;
      expect(sent).toContain('Liability');
      expect(sent).toContain('liable for any damage without any limit');
      expect(sent).toContain('Who pays for damage?');
      expect(sent).not.toContain('secret-divorce');
      expect(sent).not.toContain('response_format');
    });

    it('sends the earlier messages of the conversation on', async () => {
      const { controller, calls } = makeController({});
      await controller.ask(ID, {
        question: 'And who pays for the loss of profit?',
        history: [
          { role: 'ai', content: 'Hello. What would you like to know?' },
          { role: 'user', content: 'Who pays for damage?' },
          { role: 'ai', content: 'The supplier.' },
        ],
      });
      const body = JSON.parse(calls[0].init.body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages.map((item) => item.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(body.messages[4].content).toBe('The supplier.');
      expect(JSON.stringify(body)).not.toContain('Hello. What would you like');
    });

    it('writes nothing in the log', async () => {
      const { controller } = makeController({});
      await controller.ask(ID, { question: PRIVATE_QUESTION });
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  describe('a request that is not right (400)', () => {
    const bodies: unknown[] = [
      undefined,
      null,
      'a question',
      [],
      {},
      { question: '' },
      { question: 42 },
      { question: 'q'.repeat(MAX_QUESTION_CHARS + 1) },
      { question: 'Q', history: 'abc' },
      { question: 'Q', history: [{ role: 'system', content: 'x' }] },
      { question: 'Q', history: [{ role: 'user' }] },
    ];

    it('answers 400 with a message, without reading the store or calling the AI service', async () => {
      for (const body of bodies) {
        const { controller, calls, asked } = makeController({});
        const error = await httpFailure(controller.ask(ID, body));
        expect(error.getStatus()).toBe(400);
        expect(messageOf(error).length > 0).toBe(true);
        expect(asked).toHaveLength(0);
        expect(calls).toHaveLength(0);
      }
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('checks the body before it looks for the analysis, so an unknown id with a bad body is a 400', async () => {
      const { controller } = makeController({ found: null });
      const error = await httpFailure(controller.ask(ID, {}));
      expect(error.getStatus()).toBe(400);
    });
  });

  describe('an analysis that is not there (404)', () => {
    it('answers 404 with the same message as GET /documents/:id, and does not call the AI service', async () => {
      const { controller, calls } = makeController({ found: null });
      const error = await httpFailure(controller.ask(ID, { question: 'Q' }));
      expect(error.getStatus()).toBe(404);
      expect(messageOf(error)).toBe('There is no saved analysis with this id.');
      expect(calls).toHaveLength(0);
      expect(warn.mock.calls).toHaveLength(0);
    });

    it('gives the id to the store as it is, and the store decides', async () => {
      const { controller, asked } = makeController({ found: null });
      await failure(controller.ask('../../package', { question: 'Q' }));
      expect(asked).toEqual(['../../package']);
    });
  });

  describe('a saved file that cannot be read (500)', () => {
    it('answers 500 with the fixed message of the store, logs it with the id, and does not call the AI service', async () => {
      const { controller, calls } = makeController({
        store: { get: () => Promise.reject(new StoreError(DAMAGED_MESSAGE)) },
      });
      const error = await httpFailure(
        controller.ask(ID, { question: PRIVATE_QUESTION }),
      );
      expect(error.getStatus()).toBe(500);
      expect(messageOf(error)).toBe(DAMAGED_MESSAGE);
      expect(calls).toHaveLength(0);
      expect(warn.mock.calls).toHaveLength(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(ID);
      expect(line).toContain(DAMAGED_MESSAGE);
      expect(line).not.toContain('savings');
    });

    it('passes on another error of the store unchanged, and does not log it', async () => {
      const problem = new Error('EACCES: permission denied');
      const { controller } = makeController({
        store: { get: () => Promise.reject(problem) },
      });
      expect(await failure(controller.ask(ID, { question: 'Q' }))).toBe(
        problem,
      );
      expect(warn.mock.calls).toHaveLength(0);
    });
  });

  describe('the AI service cannot be used', () => {
    it('answers 503 when no AI service is set up, and logs it', async () => {
      const { controller, calls } = makeController({
        ai: { settings: null, problems: [] },
      });
      const error = await httpFailure(controller.ask(ID, { question: 'Q' }));
      expect(error.getStatus()).toBe(503);
      expect(messageOf(error)).toBe(ASK_NOT_SET_UP_MESSAGE);
      expect(calls).toHaveLength(0);
      expect(warn.mock.calls).toHaveLength(1);
    });

    it('answers 503 when the settings of the AI service are not valid', async () => {
      const { controller } = makeController({
        ai: { settings: null, problems: ['AI_MODEL is missing.'] },
      });
      const error = await httpFailure(controller.ask(ID, { question: 'Q' }));
      expect(error.getStatus()).toBe(503);
      expect(messageOf(error)).toBe(ASK_INVALID_SETTINGS_MESSAGE);
    });

    it('turns what the AI service does into the same answers as POST /analyze', async () => {
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      const cases: Array<[Reply, number, string]> = [
        [{ status: 500, body: 'oops' }, 502, 'had an error'],
        [{ status: 401, body: 'no' }, 502, 'did not accept the key'],
        [{ status: 404, body: 'no' }, 502, 'does not know the model'],
        [{ status: 400, body: 'no' }, 502, 'refused the request'],
        [answerOf('   '), 502, 'the answer is empty'],
        [{ status: 200, body: 'not json' }, 502, 'not with the expected data'],
        [{ status: 429, body: 'slow down' }, 503, 'too many requests'],
        [new Error('connect ECONNREFUSED'), 503, 'could not be reached'],
        [timeout, 504, 'did not answer within 5 seconds'],
      ];
      for (const [reply, status, text] of cases) {
        const { controller } = makeController({ reply });
        const error = await httpFailure(controller.ask(ID, { question: 'Q' }));
        expect(error.getStatus()).toBe(status);
        expect(messageOf(error)).toContain(text);
      }
    });

    it('logs each of these once, and never the question, the answer or the document', async () => {
      const cases: Reply[] = [
        { status: 500, body: 'a secret answer of the service' },
        { status: 429, body: 'a secret answer of the service' },
        new Error('a secret answer of the service'),
        answerOf(''),
      ];
      for (const reply of cases) {
        warn.mockRestore();
        warn = silenceWarnings();
        const { controller } = makeController({ reply });
        await failure(
          controller.ask(ID, {
            question: PRIVATE_QUESTION,
            history: [{ role: 'user', content: 'an earlier private question' }],
          }),
        );
        expect(warn.mock.calls).toHaveLength(1);
        const line = String(warn.mock.calls[0][0]);
        for (const text of [
          'secret',
          'savings',
          'private',
          'Liability',
          'liable for',
          'divorce',
          saved.executiveSummary,
          saved.clauses[0].explanation,
        ]) {
          expect(line).not.toContain(text);
        }
      }
    });
  });

  it('passes on an error that is not expected unchanged, and does not log it', async () => {
    const broken = { ...saved, clauses: undefined } as unknown as SavedAnalysis;
    const { controller } = makeController({ found: broken });
    const error = await failure(controller.ask(ID, { question: 'Q' }));
    expect(error instanceof HttpException).toBe(false);
    expect(warn.mock.calls).toHaveLength(0);
  });
});

// A response that the test can close, like the response of a request whose
// browser has left.
class FakeResponse extends EventEmitter implements WatchedResponse {
  writableFinished = false;
  destroyed = false;

  browserLeaves(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

// A fetch that never answers. It ends when the signal it was given is aborted,
// as the fetch of Node does.
function waitingFetch() {
  const calls: Call[] = [];
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const stop = (): void => {
        const aborted = new Error('This operation was aborted');
        aborted.name = 'AbortError';
        reject(aborted);
      };
      if (signal?.aborted === true) {
        stop();
      } else {
        signal?.addEventListener('abort', stop);
      }
    });
  };
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && done() === false; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (done() === false) {
    throw new Error('the test waited too long');
  }
}

function silenceLog() {
  return jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
}

describe('AskController: the browser leaves before the answer', () => {
  let warn: ReturnType<typeof silenceWarnings>;
  let log: ReturnType<typeof silenceLog>;

  beforeEach(() => {
    warn = silenceWarnings();
    log = silenceLog();
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  function waitingController(store?: Partial<DocumentStore>) {
    const fake = waitingFetch();
    const tools: AnalyzeTools = { fetchImpl: fake.fetchImpl };
    const { store: fakeStore } = storeWith({
      get: () => Promise.resolve(saved),
      ...store,
    });
    const controller = new AskController(configured, tools, fakeStore);
    return { controller, calls: fake.calls };
  }

  it('cancels the call to the AI service and answers 499, with one fixed line in the log', async () => {
    const response = new FakeResponse();
    const { controller, calls } = waitingController();
    const pending = httpFailure(
      controller.ask(ID, { question: PRIVATE_QUESTION }, response),
    );
    await until(() => calls.length === 1);
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    response.browserLeaves();
    const error = await pending;

    expect(signal.aborted).toBe(true);
    expect(error.getStatus()).toBe(CLIENT_LEFT_STATUS);
    expect(CLIENT_LEFT_STATUS).toBe(499);
    expect(CLIENT_LEFT_MESSAGE).toBe(
      'The browser stopped waiting, so the question was cancelled.',
    );
    expect(messageOf(error)).toBe(CLIENT_LEFT_MESSAGE);
    expect(log.mock.calls).toHaveLength(1);
    expect(String(log.mock.calls[0][0])).toBe(CLIENT_LEFT_MESSAGE);
    expect(warn.mock.calls).toHaveLength(0);
  });

  it('never writes the question or the document in the log, and does not call it a problem of the AI service', async () => {
    const response = new FakeResponse();
    const { controller, calls } = waitingController();
    const pending = httpFailure(
      controller.ask(
        ID,
        {
          question: PRIVATE_QUESTION,
          history: [{ role: 'user', content: 'an earlier private question' }],
        },
        response,
      ),
    );
    await until(() => calls.length === 1);
    response.browserLeaves();
    const error = await pending;
    const written = [...log.mock.calls, ...warn.mock.calls]
      .map((call) => String(call[0]))
      .join(' ');
    for (const text of ['savings', 'private', 'Liability', 'divorce']) {
      expect(written).not.toContain(text);
      expect(messageOf(error)).not.toContain(text);
    }
    expect(messageOf(error)).not.toContain('AI service');
  });

  it('does not call the AI service when the browser left while the analysis was being read', async () => {
    const response = new FakeResponse();
    let release: () => void = () => undefined;
    const { controller, calls } = waitingController({
      get: () =>
        new Promise<SavedAnalysis>((resolve) => {
          release = () => resolve(saved);
        }),
    });
    const pending = httpFailure(
      controller.ask(ID, { question: 'Q' }, response),
    );
    response.browserLeaves();
    release();
    const error = await pending;
    expect(error.getStatus()).toBe(CLIENT_LEFT_STATUS);
    expect(calls).toHaveLength(0);
  });

  it('cancels nothing when the answer comes, and leaves no listener on the response', async () => {
    const response = new FakeResponse();
    const { controller, calls } = makeController({});
    expect(
      await controller.ask(ID, { question: 'Who pays for damage?' }, response),
    ).toEqual({ answer: 'An answer.' });
    expect(response.listenerCount('close')).toBe(0);

    // The response closes after the answer was sent. Nothing is left to cancel.
    response.writableFinished = true;
    response.browserLeaves();
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(log.mock.calls).toHaveLength(0);
  });

  it('leaves no listener on the response when the AI service fails, and answers as before', async () => {
    const response = new FakeResponse();
    const { controller } = makeController({
      reply: { status: 500, body: 'oops' },
    });
    const error = await httpFailure(
      controller.ask(ID, { question: 'Q' }, response),
    );
    expect(error.getStatus()).toBe(502);
    expect(response.listenerCount('close')).toBe(0);
    expect(warn.mock.calls).toHaveLength(1);
  });

  it('turns a timeout into 504 as before when a response is watched', async () => {
    const slow = new Error('timed out');
    slow.name = 'TimeoutError';
    const response = new FakeResponse();
    const { controller } = makeController({ reply: slow });
    const error = await httpFailure(
      controller.ask(ID, { question: 'Q' }, response),
    );
    expect(error.getStatus()).toBe(504);
    expect(log.mock.calls).toHaveLength(0);
  });

  it('answers a question that has no response to watch, as before', async () => {
    const { controller } = makeController({});
    expect(await controller.ask(ID, { question: 'Q' })).toEqual({
      answer: 'An answer.',
    });
  });

  it('leaves the other answers alone: a bad body is a 400 and a missing analysis is a 404, whatever the browser does', async () => {
    const response = new FakeResponse();
    response.browserLeaves();
    const bad = makeController({});
    expect(
      (await httpFailure(bad.controller.ask(ID, {}, response))).getStatus(),
    ).toBe(400);
    const missing = makeController({ found: null });
    expect(
      (
        await httpFailure(
          missing.controller.ask(ID, { question: 'Q' }, response),
        )
      ).getStatus(),
    ).toBe(404);
    expect(log.mock.calls).toHaveLength(0);
  });
});
