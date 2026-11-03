import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type HttpException,
} from '@nestjs/common';
import { AiServiceError, type AiErrorKind } from './ai-analyzer';
import { ExtractionError, type ExtractionErrorKind } from './extraction';

// Turns the errors of reading a document and of calling the AI service into
// the HTTP answers of POST /analyze. The message of each error was written to
// be shown to the person, so it becomes the message of the answer.
//
// 415: the kind of file cannot be read (an old .doc file).
// 422: the file is understood, but its content cannot be used (a password, a
//      damaged file, or no text in it).
// 503: the AI service cannot be used now (not set up, not running, too many
//      requests). Trying again later can work.
// 504: the AI service did not answer in time.
// 502: the AI service answered with an error or with something unusable.

type MakeAnswer = (message: string) => HttpException;

const unprocessable: MakeAnswer = (message) =>
  new UnprocessableEntityException(message);
const unavailable: MakeAnswer = (message) =>
  new ServiceUnavailableException(message);
const badGateway: MakeAnswer = (message) => new BadGatewayException(message);

// A Record, so that the compiler complains when a new kind is added to the
// errors and not to this list.
const FOR_EXTRACTION: Record<ExtractionErrorKind, MakeAnswer> = {
  'unsupported-format': (message) => new UnsupportedMediaTypeException(message),
  'password-protected': unprocessable,
  unreadable: unprocessable,
};

const FOR_AI: Record<AiErrorKind, MakeAnswer> = {
  'no-text': unprocessable,
  'not-configured': unavailable,
  unreachable: unavailable,
  'rate-limited': unavailable,
  timeout: (message) => new GatewayTimeoutException(message),
  rejected: badGateway,
  'model-not-found': badGateway,
  'service-error': badGateway,
  'bad-answer': badGateway,
};

// The HTTP answer for a known error, or null for any other error (a bug, or a
// problem of this computer). Nest answers 500 for those, with a general text
// that does not reveal the details, and writes the details in the log.
export function toHttpException(error: unknown): HttpException | null {
  if (error instanceof ExtractionError) {
    return FOR_EXTRACTION[error.kind](error.message);
  }
  if (error instanceof AiServiceError) {
    return FOR_AI[error.kind](error.message);
  }
  return null;
}
