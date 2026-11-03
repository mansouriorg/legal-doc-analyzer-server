import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { ExtractionError, LONG_DOCUMENT_NOTE } from './extraction';
import {
  PDF_LIMITS,
  readPdfText,
  type PdfLibrary,
  type PdfTextItem,
} from './pdf-text';

// A fake of the PDF package. Each page is a list of text items.
interface Fake {
  library: PdfLibrary;
  options: Record<string, unknown>[];
  destroyed: number[];
  cleaned: number[];
  readPages: number[];
}

function fakePdf(
  pages: PdfTextItem[][],
  fail: { document?: unknown; page?: Error; destroy?: Error } = {},
): Fake {
  const fake: Fake = {
    library: undefined as unknown as PdfLibrary,
    options: [],
    destroyed: [],
    cleaned: [],
    readPages: [],
  };
  fake.library = {
    getDocument: (options) => {
      fake.options.push(options);
      return {
        promise:
          'document' in fail
            ? Promise.resolve().then(() => {
                throw fail.document;
              })
            : Promise.resolve({
                numPages: pages.length,
                getPage: (pageNumber: number) => {
                  fake.readPages.push(pageNumber);
                  if (fail.page !== undefined) {
                    return Promise.reject(fail.page);
                  }
                  return Promise.resolve({
                    getTextContent: () =>
                      Promise.resolve({ items: pages[pageNumber - 1] }),
                    cleanup: () => fake.cleaned.push(pageNumber),
                  });
                },
              }),
        destroy: () => {
          fake.destroyed.push(1);
          return fail.destroy === undefined
            ? Promise.resolve()
            : Promise.reject(fail.destroy);
        },
      };
    },
  };
  return fake;
}

async function failure(promise: Promise<unknown>): Promise<ExtractionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExtractionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an ExtractionError, but nothing was thrown');
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const file = Buffer.from('%PDF-1.7 pretend');

describe('readPdfText', () => {
  it('joins the pieces of each page and puts a blank line between pages', async () => {
    const fake = fakePdf([
      [{ str: 'Hello ' }, { str: 'world', hasEOL: true }],
      [{ str: 'Page two' }],
    ]);
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(read).toEqual({ text: 'Hello world\n\n\nPage two', notes: [] });
  });

  it('keeps the line break at the end of a page as it was read', async () => {
    const fake = fakePdf([[{ str: 'Last line', hasEOL: true }]]);
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(read.text).toBe('Last line\n');
  });

  it('skips items that have no text', async () => {
    const fake = fakePdf([
      [{}, { str: 'A' }, { hasEOL: true }, { str: 'B', hasEOL: false }],
    ]);
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(read.text).toBe('AB');
  });

  it('gives the package a copy of the file and safe settings', async () => {
    const fake = fakePdf([[{ str: 'x' }]]);
    await readPdfText(file, () => Promise.resolve(fake.library));
    expect(fake.options).toHaveLength(1);
    const options = fake.options[0];
    const data = options.data as Uint8Array;
    expect(Buffer.from(data).equals(file)).toBe(true);
    expect(data.buffer === file.buffer).toBe(false);
    expect(options.isEvalSupported).toBe(false);
    expect(options.disableFontFace).toBe(true);
    expect(options.useSystemFonts).toBe(false);
    expect(options.verbosity).toBe(0);
  });

  it('points the package to its character maps and standard fonts', async () => {
    const fake = fakePdf([[{ str: 'x' }]]);
    await readPdfText(file, () => Promise.resolve(fake.library));
    const options = fake.options[0];
    expect(options.cMapPacked).toBe(true);
    expect(existsSync(options.cMapUrl as string)).toBe(true);
    expect(existsSync(options.standardFontDataUrl as string)).toBe(true);
    expect((options.cMapUrl as string).endsWith(sep)).toBe(true);
    expect((options.standardFontDataUrl as string).endsWith(sep)).toBe(true);
    expect(options.cMapUrl).toContain('cmaps');
    expect(options.standardFontDataUrl).toContain('standard_fonts');
  });

  it('frees the document and each page after reading', async () => {
    const fake = fakePdf([[{ str: 'a' }], [{ str: 'b' }]]);
    await readPdfText(file, () => Promise.resolve(fake.library));
    expect(fake.destroyed).toHaveLength(1);
    expect(fake.cleaned).toEqual([1, 2]);
  });

  it('returns an empty text for a PDF without text', async () => {
    const fake = fakePdf([[]]);
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(read).toEqual({ text: '', notes: [] });
  });

  it('says that a PDF is protected by a password', async () => {
    const fake = fakePdf([], {
      document: named('PasswordException', 'No password given'),
    });
    const error = await failure(
      readPdfText(file, () => Promise.resolve(fake.library)),
    );
    expect(error.kind).toBe('password-protected');
    expect(error.message).toContain('protected by a password');
    expect(fake.destroyed).toHaveLength(1);
  });

  it('says that a damaged PDF cannot be read, without the details of the package', async () => {
    const fake = fakePdf([], {
      document: named('InvalidPDFException', 'secret internal detail'),
    });
    const error = await failure(
      readPdfText(file, () => Promise.resolve(fake.library)),
    );
    expect(error.kind).toBe('unreadable');
    expect(error.message).toContain('could not be read');
    expect(error.message).not.toContain('secret internal detail');
    expect(fake.destroyed).toHaveLength(1);
  });

  it('treats an error on a page like a damaged file, and still frees the document', async () => {
    const fake = fakePdf([[{ str: 'a' }]], { page: new Error('bad page') });
    const error = await failure(
      readPdfText(file, () => Promise.resolve(fake.library)),
    );
    expect(error.kind).toBe('unreadable');
    expect(fake.destroyed).toHaveLength(1);
  });

  it('lets a failure to load the package through, because it is not the fault of the file', async () => {
    const problem = new Error('cannot load the package');
    let caught: unknown;
    try {
      await readPdfText(file, () => Promise.reject(problem));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(problem);
  });

  it('stops at the page limit and says so', async () => {
    const pages = [1, 2, 3, 4, 5].map((n) => [{ str: `Page ${n}` }]);
    const fake = fakePdf(pages);
    const read = await readPdfText(file, () => Promise.resolve(fake.library), {
      ...PDF_LIMITS,
      maxPages: 2,
    });
    expect(read.text).toBe('Page 1\n\nPage 2');
    expect(fake.readPages).toEqual([1, 2]);
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toContain('Only the first 2 of 5 pages');
  });

  it('stops at the character limit and says the document is long', async () => {
    const pages = [1, 2, 3, 4, 5].map(() => [{ str: 'abcdef' }]);
    const fake = fakePdf(pages);
    const read = await readPdfText(file, () => Promise.resolve(fake.library), {
      ...PDF_LIMITS,
      maxChars: 12,
    });
    expect(fake.readPages).toEqual([1, 2]);
    expect(read.notes).toEqual([LONG_DOCUMENT_NOTE]);
  });

  it('stops when reading takes too long, and says so', async () => {
    const pages = [1, 2, 3, 4, 5].map((n) => [{ str: `Page ${n}` }]);
    const fake = fakePdf(pages);
    let clock = 4500;
    const read = await readPdfText(file, () => Promise.resolve(fake.library), {
      ...PDF_LIMITS,
      maxMilliseconds: 1000,
      now: () => (clock += 500),
    });
    expect(fake.readPages).toEqual([1, 2]);
    expect(read.notes[0]).toContain('Only the first 2 of 5 pages');
  });

  it('has the limits that the README names', () => {
    expect(PDF_LIMITS.maxPages).toBe(300);
    expect(PDF_LIMITS.maxChars).toBe(200000);
    expect(PDF_LIMITS.maxMilliseconds).toBe(30000);
    expect(Math.abs(PDF_LIMITS.now() - Date.now())).toBeLessThanOrEqual(1000);
  });

  it('still returns the text when freeing the document fails', async () => {
    const fake = fakePdf([[{ str: 'Text' }]], {
      destroy: new Error('cannot free'),
    });
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(read.text).toBe('Text');
    expect(fake.destroyed).toHaveLength(1);
  });

  it('treats an error that is not an Error object like a damaged file', async () => {
    for (const problem of ['boom', null, undefined, 42]) {
      const fake = fakePdf([], { document: problem });
      const error = await failure(
        readPdfText(file, () => Promise.resolve(fake.library)),
      );
      expect(error.kind).toBe('unreadable');
    }
  });

  it('reads all pages when no limit is reached', async () => {
    const pages = [1, 2, 3].map((n) => [{ str: `P${n}` }]);
    const fake = fakePdf(pages);
    const read = await readPdfText(file, () => Promise.resolve(fake.library));
    expect(fake.readPages).toEqual([1, 2, 3]);
    expect(read.notes).toEqual([]);
  });
});
