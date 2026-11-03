import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import { makeDocx, paragraph } from '../test/helpers/make-docx';
import {
  AiRequestCancelledError,
  AiServiceError,
  analyzeText,
} from './ai-analyzer';
import type { AiSettings, AiSettingsResult } from './ai-settings';
import { analyzeDocument, type AnalyzeTools } from './analyze-document';
import {
  ANALYSIS_CANCELLED_MESSAGE,
  AnalyzeController,
} from './analyze.controller';
import { CLIENT_LEFT_STATUS } from './ask.controller';
import type { WatchedResponse } from './client-gone';
import type { DocumentStore, SavedAnalysis } from './document-store';
import type { ExtractedText } from './extraction';
import type { SaveSetting } from './save-setting';
import type { TextReaders } from './text-extractor';
import type { UploadedDocument } from './upload-rules';

// What happens to POST /analyze when the browser leaves before the analysis is
// ready: the call to the AI service is cancelled, nothing is saved, and the
// log gets one fixed line. The question endpoint does the same (see
// ask.controller.spec.ts); these tests are for the analysis.

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

const wordFile = makeDocx(
  contract
    .split('\n')
    .map((line) => paragraph(line))
    .join(''),
);

function upload(): UploadedDocument {
  return {
    originalname: 'secret-divorce.docx',
    size: wordFile.length,
    buffer: wordFile,
  };
}

interface Call {
  url: string;
  init: RequestInit;
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

// A fetch that answers at once, and remembers its calls.
function answeringFetch(status: number, body: string) {
  const calls: Call[] = [];
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    } as Response);
  };
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

// Readers that count how often a Word file is read.
function countingReaders() {
  const state = { reads: 0 };
  const readers: TextReaders = {
    pdf: () => Promise.reject(new Error('a PDF was not expected')),
    docx: (): ExtractedText => {
      state.reads += 1;
      return { text: contract, notes: [] };
    },
  };
  return { state, readers };
}

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

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && done() === false; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (done() === false) {
    throw new Error('the test waited too long');
  }
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
  const body = error.getResponse();
  return typeof body === 'string' ? body : JSON.stringify(body);
}

describe('analyzeText: the caller cancels', () => {
  it('sends nothing when the signal is already aborted', async () => {
    const { calls, fetchImpl } = answeringFetch(200, goodAnswer);
    const cancel = AbortSignal.abort();
    const error = await failure(
      analyzeText({
        settings,
        documentName: 'a.docx',
        text: contract,
        fetchImpl,
        cancel,
      }),
    );
    expect(error instanceof AiRequestCancelledError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('drops the call to the AI service when the signal is aborted, and says so with its own error', async () => {
    const { calls, fetchImpl } = waitingFetch();
    const controller = new AbortController();
    const pending = failure(
      analyzeText({
        settings,
        documentName: 'a.docx',
        text: contract,
        fetchImpl,
        cancel: controller.signal,
      }),
    );
    await until(() => calls.length === 1);
    const sent = calls[0].init.signal as AbortSignal;
    expect(sent.aborted).toBe(false);

    controller.abort();
    const error = await pending;

    expect(sent.aborted).toBe(true);
    expect(error instanceof AiRequestCancelledError).toBe(true);
    // It is not a timeout and not an AI service that cannot be reached.
    expect(error instanceof AiServiceError).toBe(false);
  });

  it('does not ask again without response_format when the caller has left after the first answer', async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    const impl = (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      // The service does not know response_format (400), and the browser
      // leaves while this answer is on its way.
      controller.abort();
      return Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve('unknown field'),
      } as Response);
    };
    const error = await failure(
      analyzeText({
        settings,
        documentName: 'a.docx',
        text: contract,
        fetchImpl: impl as unknown as typeof fetch,
        cancel: controller.signal,
      }),
    );
    expect(error instanceof AiRequestCancelledError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('gives the same result as before when the signal is never aborted', async () => {
    const { calls, fetchImpl } = answeringFetch(200, goodAnswer);
    const controller = new AbortController();
    const withSignal = await analyzeText({
      settings,
      documentName: 'a.docx',
      text: contract,
      fetchImpl,
      cancel: controller.signal,
    });
    const without = await analyzeText({
      settings,
      documentName: 'a.docx',
      text: contract,
      fetchImpl,
    });
    expect(withSignal).toEqual(without);
    expect(withSignal.clauses).toHaveLength(1);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(false);
  });
});

describe('analyzeDocument: the caller cancels', () => {
  it('does not read the file and does not call the AI service when the signal is already aborted', async () => {
    const { state, readers } = countingReaders();
    const { calls, fetchImpl } = answeringFetch(200, goodAnswer);
    const tools: AnalyzeTools = { readers, fetchImpl };
    const error = await failure(
      analyzeDocument(upload(), configured, tools, AbortSignal.abort()),
    );
    expect(error instanceof AiRequestCancelledError).toBe(true);
    expect(state.reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('hands the signal on to the call to the AI service', async () => {
    const { calls, fetchImpl } = waitingFetch();
    const { state, readers } = countingReaders();
    const controller = new AbortController();
    const pending = failure(
      analyzeDocument(
        upload(),
        configured,
        { readers, fetchImpl },
        controller.signal,
      ),
    );
    await until(() => calls.length === 1);
    expect(state.reads).toBe(1);

    controller.abort();
    const error = await pending;
    expect(error instanceof AiRequestCancelledError).toBe(true);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });

  it('still answers a missing AI setting first, as before', async () => {
    const error = await failure(
      analyzeDocument(
        upload(),
        { settings: null, problems: [] },
        {},
        AbortSignal.abort(),
      ),
    );
    expect(error instanceof AiServiceError).toBe(true);
    expect((error as AiServiceError).kind).toBe('not-configured');
  });

  it('works as before without a signal', async () => {
    const { fetchImpl } = answeringFetch(200, goodAnswer);
    const result = await analyzeDocument(upload(), configured, { fetchImpl });
    expect(result.documentName).toBe('secret-divorce.docx');
    expect(result.clauses).toHaveLength(1);
  });
});

const SAVED_AT = '2026-10-25T16:30:00.000Z';

// A store that keeps the analyses in memory. `saved` is what it was asked to save.
function memoryStore(onSave?: () => void) {
  const saved: SavedAnalysis[] = [];
  const store: DocumentStore = {
    save: (analysis) => {
      onSave?.();
      const entry: SavedAnalysis = {
        id: `00000000-0000-4000-8000-${String(saved.length + 1).padStart(12, '0')}`,
        savedAt: SAVED_AT,
        ...analysis,
      };
      saved.push(entry);
      return Promise.resolve(entry);
    },
    get: () => Promise.resolve(null),
    list: () => Promise.resolve({ documents: [], total: 0, unreadable: 0 }),
    delete: () => Promise.reject(new Error('delete was not expected')),
  };
  return { store, saved };
}

const savingOn: SaveSetting = { enabled: true, problem: null };

function silenceWarnings() {
  return jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

function silenceLog() {
  return jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
}

describe('AnalyzeController: the browser leaves before the analysis is ready', () => {
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

  it('cancels the call to the AI service, saves nothing, answers 499, and writes one fixed line in the log', async () => {
    const response = new FakeResponse();
    const { calls, fetchImpl } = waitingFetch();
    const { store, saved } = memoryStore();
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      store,
      savingOn,
    );
    const pending = httpFailure(
      controller.analyze(upload(), undefined, response),
    );
    await until(() => calls.length === 1);
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    response.browserLeaves();
    const error = await pending;

    expect(signal.aborted).toBe(true);
    expect(error.getStatus()).toBe(CLIENT_LEFT_STATUS);
    expect(CLIENT_LEFT_STATUS).toBe(499);
    expect(ANALYSIS_CANCELLED_MESSAGE).toBe(
      'The browser stopped waiting, so the analysis was cancelled.',
    );
    expect(messageOf(error)).toBe(ANALYSIS_CANCELLED_MESSAGE);
    expect(saved).toHaveLength(0);
    expect(log.mock.calls).toHaveLength(1);
    expect(String(log.mock.calls[0][0])).toBe(ANALYSIS_CANCELLED_MESSAGE);
    expect(warn.mock.calls).toHaveLength(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('never writes the name or the text of the document in the log, and does not call it a problem of the AI service', async () => {
    const response = new FakeResponse();
    const { calls, fetchImpl } = waitingFetch();
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      memoryStore().store,
      savingOn,
    );
    const pending = httpFailure(
      controller.analyze(upload(), undefined, response),
    );
    await until(() => calls.length === 1);
    response.browserLeaves();
    const error = await pending;
    const written = [...log.mock.calls, ...warn.mock.calls]
      .map((call) => String(call[0]))
      .join(' ');
    for (const text of ['secret', 'divorce', 'Liability', 'liable']) {
      expect(written).not.toContain(text);
      expect(messageOf(error)).not.toContain(text);
    }
    expect(messageOf(error)).not.toContain('AI service');
  });

  it('does not read the file and does not call the AI service when the browser left before the analysis started', async () => {
    const response = new FakeResponse();
    response.browserLeaves();
    const { state, readers } = countingReaders();
    const { calls, fetchImpl } = waitingFetch();
    const { store, saved } = memoryStore();
    const controller = new AnalyzeController(
      configured,
      { readers, fetchImpl },
      store,
      savingOn,
    );
    const error = await httpFailure(
      controller.analyze(upload(), undefined, response),
    );
    expect(error.getStatus()).toBe(CLIENT_LEFT_STATUS);
    expect(state.reads).toBe(0);
    expect(calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('cancels nothing and saves as usual when the analysis comes, and leaves no listener on the response', async () => {
    const response = new FakeResponse();
    const { calls, fetchImpl } = answeringFetch(200, goodAnswer);
    const { store, saved } = memoryStore();
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      store,
      savingOn,
    );
    const result = await controller.analyze(upload(), undefined, response);
    expect(result.clauses).toHaveLength(1);
    expect(result.id).toBe(saved[0].id);
    expect(response.listenerCount('close')).toBe(0);

    // The response closes after the answer was sent. Nothing is left to cancel.
    response.writableFinished = true;
    response.browserLeaves();
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(false);
    expect(log.mock.calls).toHaveLength(0);
    expect(saved).toHaveLength(1);
  });

  it('saves as usual when the browser leaves after the AI service has answered', async () => {
    const response = new FakeResponse();
    const { calls, fetchImpl } = answeringFetch(200, goodAnswer);
    // The browser leaves while the analysis is being saved.
    const { store, saved } = memoryStore(() => response.browserLeaves());
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      store,
      savingOn,
    );
    const result = await controller.analyze(upload(), undefined, response);
    expect(result.id).toBe(saved[0].id);
    expect(saved).toHaveLength(1);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(false);
    expect(log.mock.calls).toHaveLength(0);
  });

  it('leaves no listener on the response when the AI service fails, and answers as before', async () => {
    const response = new FakeResponse();
    const { fetchImpl } = answeringFetch(500, 'oops');
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      memoryStore().store,
      savingOn,
    );
    const error = await httpFailure(
      controller.analyze(upload(), undefined, response),
    );
    expect(error.getStatus()).toBe(502);
    expect(response.listenerCount('close')).toBe(0);
    expect(log.mock.calls).toHaveLength(0);
  });

  it('leaves no listener on the response when the file is refused, and answers as before', async () => {
    const response = new FakeResponse();
    const controller = new AnalyzeController(
      configured,
      {},
      memoryStore().store,
      savingOn,
    );
    const error = await httpFailure(
      controller.analyze(
        {
          originalname: 'notes.txt',
          size: 5,
          buffer: Buffer.from('hello'),
        },
        undefined,
        response,
      ),
    );
    expect(error.getStatus()).toBe(400);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('works as before without a response', async () => {
    const { fetchImpl } = answeringFetch(200, goodAnswer);
    const { store, saved } = memoryStore();
    const controller = new AnalyzeController(
      configured,
      { fetchImpl },
      store,
      savingOn,
    );
    const result = await controller.analyze(upload());
    expect(result.id).toBe(saved[0].id);
  });
});

function read(path: string): string {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

describe('stopping an analysis: the code and the README agree', () => {
  it('watches the browser before the analysis starts and stops watching before the analysis is saved', () => {
    const controller = read('src/analyze.controller.ts');
    expect(controller).toContain('@Res({ passthrough: true })');
    expect(controller).toContain('const watch = watchClient(response);');
    expect(controller).toContain('watch.signal');
    expect(controller).toContain('watch.stop();');
    const watching = controller.indexOf('const watch = watchClient(response);');
    const calling = controller.indexOf('analyzeDocument(');
    const stopping = controller.indexOf('watch.stop();');
    const saving = controller.indexOf('return this.keep(analysis, decision);');
    expect(watching).not.toBe(-1);
    expect(watching < calling).toBe(true);
    expect(calling < stopping).toBe(true);
    expect(stopping < saving).toBe(true);
  });

  it('answers the cancelled analysis before it looks for another kind of error', () => {
    const controller = read('src/analyze.controller.ts');
    const cancelled = controller.indexOf(
      'error instanceof AiRequestCancelledError',
    );
    const expected = controller.indexOf('toHttpException(error)');
    expect(cancelled).not.toBe(-1);
    expect(cancelled < expected).toBe(true);
    expect(controller).toContain(
      'this.logger.log(ANALYSIS_CANCELLED_MESSAGE);',
    );
    expect(controller).toContain(
      'new HttpException(ANALYSIS_CANCELLED_MESSAGE, CLIENT_LEFT_STATUS)',
    );
  });

  it('hands the signal from the controller down to the call to the AI service', () => {
    expect(read('src/analyze-document.ts')).toContain('cancel?: AbortSignal,');
    expect(read('src/analyze-document.ts')).toContain('    cancel,\n  });');
    expect(read('src/ai-analyzer.ts')).toContain('  cancel?: AbortSignal;\n}');
    expect(read('src/ai-analyzer.ts')).toContain('    input.cancel,\n  );');
  });

  it('says in the README what POST /analyze does when the browser stops waiting', () => {
    const readme = read('README.md');
    expect(readme).toContain(
      '- When the browser stops waiting for an analysis (the person closed the tab or left the page), `POST /analyze` cancels its call to the AI service too, and saves nothing.',
    );
    expect(readme).toContain(
      '  - 499: the browser dropped the request before the analysis was ready',
    );
    expect(readme).toContain(
      'Stopping an analysis: the browser can drop the request before the analysis is ready',
    );
    expect(readme).toContain(
      'The log gets one fixed line ("The browser stopped waiting, so the analysis was cancelled.")',
    );
    expect(readme).toContain(
      '`POST /analyze` stops in the same way (see "Stopping an analysis" under "Endpoints").',
    );
    expect(readme).toContain('Such a request saves no analysis.');
    expect(readme).toContain(
      'If the browser had already left before the reading of the file started, the file is not read.',
    );
    expect(readme).toContain(
      'If the browser leaves after the AI service has answered, the analysis is saved as usual.',
    );
    expect(readme).toContain('(`test/analyze-cancel.e2e-spec.ts`)');
    expect(readme).not.toContain('`POST /analyze` is not changed.');
  });

  it('says in the README what was tried and what was not', () => {
    const readme = read('README.md');
    expect(readme).toContain(
      'It has not been tried with a real model: the call is the same kind of request as for a question',
    );
    expect(readme).toContain(
      'stopping an analysis (closing the page while the model works on it)',
    );
  });
});
