import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AiServiceError, type AiErrorKind } from './ai-analyzer';
import { toHttpException } from './analyze-errors';
import { ExtractionError, type ExtractionErrorKind } from './extraction';

// One line for every kind. These are Records, so that this file does not
// compile when a kind is added to the errors and not here.
const EXTRACTION_STATUS: Record<ExtractionErrorKind, number> = {
  'unsupported-format': 415,
  'password-protected': 422,
  unreadable: 422,
};

const AI_STATUS: Record<AiErrorKind, number> = {
  'no-text': 422,
  'not-configured': 503,
  unreachable: 503,
  'rate-limited': 503,
  timeout: 504,
  rejected: 502,
  'model-not-found': 502,
  'service-error': 502,
  'bad-answer': 502,
};

function answerFor(error: unknown): HttpException {
  const answer = toHttpException(error);
  if (answer === null) {
    throw new Error('expected an HTTP answer, but got null');
  }
  return answer;
}

describe('toHttpException', () => {
  for (const kind of Object.keys(EXTRACTION_STATUS) as ExtractionErrorKind[]) {
    it(`answers ${EXTRACTION_STATUS[kind]} for the reading error "${kind}", with its message`, () => {
      const answer = answerFor(
        new ExtractionError(kind, `Message for ${kind}.`),
      );
      expect(answer).toBeInstanceOf(HttpException);
      expect(answer.getStatus()).toBe(EXTRACTION_STATUS[kind]);
      expect(answer.message).toBe(`Message for ${kind}.`);
    });
  }

  for (const kind of Object.keys(AI_STATUS) as AiErrorKind[]) {
    it(`answers ${AI_STATUS[kind]} for the AI error "${kind}", with its message`, () => {
      const answer = answerFor(
        new AiServiceError(kind, `Message for ${kind}.`),
      );
      expect(answer).toBeInstanceOf(HttpException);
      expect(answer.getStatus()).toBe(AI_STATUS[kind]);
      expect(answer.message).toBe(`Message for ${kind}.`);
    });
  }

  it('uses the named Nest exceptions, so that the answer has the usual shape', () => {
    expect(
      answerFor(new ExtractionError('unsupported-format', 'x')),
    ).toBeInstanceOf(UnsupportedMediaTypeException);
    expect(answerFor(new ExtractionError('unreadable', 'x'))).toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(answerFor(new AiServiceError('unreachable', 'x'))).toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(answerFor(new AiServiceError('timeout', 'x'))).toBeInstanceOf(
      GatewayTimeoutException,
    );
    expect(answerFor(new AiServiceError('bad-answer', 'x'))).toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('puts the message in the body of the answer', () => {
    const answer = answerFor(new AiServiceError('timeout', 'Too slow.'));
    expect(JSON.stringify(answer.getResponse())).toContain('Too slow.');
  });

  it('gives null for any other error, so that Nest answers 500 and logs it', () => {
    expect(toHttpException(new Error('boom'))).toBeNull();
    expect(toHttpException(new TypeError('boom'))).toBeNull();
    expect(toHttpException('boom')).toBeNull();
    expect(toHttpException(null)).toBeNull();
    expect(toHttpException(undefined)).toBeNull();
    expect(toHttpException({ kind: 'timeout', message: 'x' })).toBeNull();
  });
});
