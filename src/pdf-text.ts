import { dirname, join, sep } from 'node:path';
import {
  ExtractionError,
  LONG_DOCUMENT_NOTE,
  MAX_TEXT_CHARS,
  type ExtractedText,
} from './extraction';

// Reads the text of a PDF file with the package pdfjs-dist (the PDF reader of
// Firefox). Text that is a picture, as in a scanned page, is not read: it
// would need character recognition (OCR), which this project does not have.
//
// The package is loaded the first time a PDF is read, because it is large and
// because it is an ES module, which this CommonJS project can only load with
// import(). The tests give a small fake in its place; the real package is
// tried by the check command (it cannot be loaded by Jest).
//
// A PDF comes from a person we do not know, and the package reads it inside
// this process. The settings below switch off what the package does not need
// for text (running code for fonts, using fonts of the computer), and the
// reading stops after a number of pages, characters or seconds. A file that
// makes the package loop forever without ever giving control back is not
// stopped by this: for a public service, run the reading in a separate process.

// The part of the package that is used. The real package has far more.
export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
export interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup(): unknown;
}
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<unknown>;
}
export interface PdfLibrary {
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
}
export type PdfLibraryLoader = () => Promise<PdfLibrary>;

export interface PdfLimits {
  maxPages: number;
  maxChars: number;
  maxMilliseconds: number;
  now: () => number;
}

export const PDF_LIMITS: PdfLimits = {
  maxPages: 300,
  maxChars: MAX_TEXT_CHARS,
  maxMilliseconds: 30000,
  now: () => Date.now(),
};

// The "legacy" build of the package is the one made for Node. When it is
// loaded, it takes DOMMatrix (which Node does not have) from its optional
// package @napi-rs/canvas. Without that package, loading fails with "DOMMatrix
// is not defined". That is a problem of this computer and not of a PDF, so it
// is reported as a plain error with advice, and not as a damaged file.
async function loadPdfLibrary(): Promise<PdfLibrary> {
  try {
    const library: unknown = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return library as PdfLibrary;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(
      `The PDF reader could not be loaded (${reason}). If this mentions DOMMatrix, the package @napi-rs/canvas is missing: run "pnpm install" again (the package may not exist for this system).`,
      { cause: error },
    );
  }
}

// The package keeps the character maps (needed for Chinese, Japanese and
// Korean text, which is empty without them) and standard fonts in its own
// folder. Returns nothing when the folder is not found.
function resourceOptions(): Record<string, unknown> {
  try {
    const folder = dirname(require.resolve('pdfjs-dist/package.json'));
    return {
      cMapUrl: join(folder, 'cmaps') + sep,
      cMapPacked: true,
      standardFontDataUrl: join(folder, 'standard_fonts') + sep,
    };
  } catch {
    return {};
  }
}

function pageText(items: PdfTextItem[]): string {
  return items
    .map((item) =>
      typeof item.str === 'string'
        ? item.str + (item.hasEOL === true ? '\n' : '')
        : '',
    )
    .join('');
}

function explain(error: unknown): ExtractionError {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PasswordException'
  ) {
    return new ExtractionError(
      'password-protected',
      'The PDF is protected by a password. Please remove the protection and upload it again.',
    );
  }
  return new ExtractionError(
    'unreadable',
    'The PDF could not be read. It may be damaged. Please save or print it again as a new PDF.',
  );
}

export async function readPdfText(
  buffer: Buffer,
  loadLibrary: PdfLibraryLoader = loadPdfLibrary,
  limits: PdfLimits = PDF_LIMITS,
): Promise<ExtractedText> {
  const library = await loadLibrary();
  const started = limits.now();
  // The package may take over the memory of the data it is given, so it gets a copy.
  const task = library.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    ...resourceOptions(),
  });

  try {
    const document = await task.promise;
    const total = document.numPages;
    const pages: string[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      if (
        pageNumber > limits.maxPages ||
        length >= limits.maxChars ||
        limits.now() - started > limits.maxMilliseconds
      ) {
        break;
      }
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      page.cleanup();
      pages.push(text);
      length += text.length;
    }

    const notes: string[] = [];
    if (pages.length < total) {
      notes.push(
        length >= limits.maxChars
          ? LONG_DOCUMENT_NOTE
          : `Only the first ${pages.length} of ${total} pages were read, because the document is long or slow to read.`,
      );
    }
    return { text: pages.join('\n\n'), notes };
  } catch (error) {
    throw explain(error);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
