// What the readers of document text have in common: the shape of their result,
// the limit on how much they read, and the error they throw. The reader of Word
// files is in docx-text.ts, the reader of PDF files is in pdf-text.ts, and
// text-extractor.ts picks the right one for an uploaded file. POST /analyze
// uses text-extractor.ts (see analyze-document.ts).

export interface ExtractedText {
  text: string;
  // Things the person should know about how the text was read, for example
  // that the document has tracked changes. They are meant to be shown with the
  // analysis.
  notes: string[];
}

// The most characters that are read from one document. The analysis reads far
// less (see AI_MAX_INPUT_CHARS, 30000 by default), so reading on would only
// cost time and memory.
export const MAX_TEXT_CHARS = 200000;

export const LONG_DOCUMENT_NOTE =
  'The document is very long, so only its beginning was read.';

export type ExtractionErrorKind =
  | 'unsupported-format'
  | 'password-protected'
  | 'unreadable';

// An error whose message can be shown to the person.
export class ExtractionError extends Error {
  readonly kind: ExtractionErrorKind;

  constructor(kind: ExtractionErrorKind, message: string) {
    super(message);
    this.name = 'ExtractionError';
    this.kind = kind;
  }
}
