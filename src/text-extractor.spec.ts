import { makeDocx, paragraph } from '../test/helpers/make-docx';
import {
  ExtractionError,
  LONG_DOCUMENT_NOTE,
  MAX_TEXT_CHARS,
  type ExtractedText,
} from './extraction';
import { extractText, type TextReaders } from './text-extractor';

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

// Fake readers that remember what they were given.
function fakeReaders(result: ExtractedText = { text: 'text', notes: [] }): {
  readers: TextReaders;
  calls: string[];
} {
  const calls: string[] = [];
  const readers: TextReaders = {
    pdf: (buffer) => {
      calls.push(`pdf ${buffer.toString()}`);
      return Promise.resolve(result);
    },
    docx: (buffer) => {
      calls.push(`docx ${buffer.toString()}`);
      return result;
    },
  };
  return { readers, calls };
}

const ligature = String.fromCharCode(0xfb01);

describe('extractText', () => {
  it('uses the PDF reader for a .pdf file, whatever the case of the name', async () => {
    const { readers, calls } = fakeReaders({
      text: 'From a PDF',
      notes: ['a note'],
    });
    const read = await extractText(
      { originalname: 'Contract.PDF', buffer: Buffer.from('one') },
      readers,
    );
    expect(read).toEqual({ text: 'From a PDF', notes: ['a note'] });
    expect(calls).toEqual(['pdf one']);
  });

  it('uses the Word reader for a .docx file, whatever the case of the name', async () => {
    const { readers, calls } = fakeReaders({ text: 'From Word', notes: [] });
    const read = await extractText(
      { originalname: 'contract.DocX', buffer: Buffer.from('two') },
      readers,
    );
    expect(read.text).toBe('From Word');
    expect(calls).toEqual(['docx two']);
  });

  it('says that an old .doc file cannot be read, and what to do', async () => {
    const { readers, calls } = fakeReaders();
    const error = await failure(
      extractText(
        { originalname: 'old.doc', buffer: Buffer.from('x') },
        readers,
      ),
    );
    expect(error.kind).toBe('unsupported-format');
    expect(error.message).toContain('"old.doc"');
    expect(error.message).toContain('old Word file (.doc)');
    expect(error.message).toContain('.docx or as a PDF');
    expect(calls).toEqual([]);
  });

  it('refuses any other kind of file', async () => {
    const { readers, calls } = fakeReaders();
    const error = await failure(
      extractText(
        { originalname: 'notes.txt', buffer: Buffer.from('x') },
        readers,
      ),
    );
    expect(error.kind).toBe('unsupported-format');
    expect(error.message).toContain('"notes.txt"');
    expect(error.message).toContain('not a PDF or Word document');
    expect(calls).toEqual([]);
  });

  it('lets the error of a reader through', async () => {
    const problem = new ExtractionError('password-protected', 'A password.');
    const readers: TextReaders = {
      pdf: () => Promise.reject(problem),
      docx: () => {
        throw problem;
      },
    };
    const error = await failure(
      extractText({ originalname: 'a.pdf', buffer: Buffer.from('x') }, readers),
    );
    expect(error).toBe(problem);
  });

  it('turns ligatures into plain letters', async () => {
    const { readers } = fakeReaders({
      text: `${ligature}rst ${ligature}nal o${String.fromCharCode(0xfb03)}ce`,
      notes: [],
    });
    const read = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toBe('first final office');
  });

  it('turns the joined forms of Arabic letters into the plain letters', async () => {
    const joined = String.fromCharCode(0xfe8d, 0xfedf);
    const plain = String.fromCharCode(0x627, 0x644);
    const { readers } = fakeReaders({ text: `${joined} ${plain}`, notes: [] });
    const read = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toBe(`${plain} ${plain}`);
  });

  it('joins a letter and a separate accent mark, and changes nothing else', async () => {
    const separate = `e${String.fromCharCode(0x301)}`;
    const squareMetre = `100 m${String.fromCharCode(0xb2)}`;
    const euro = String.fromCharCode(0x20ac);
    const { readers } = fakeReaders({
      text: `caf${separate} ${squareMetre} 5${euro} ${String.fromCharCode(0x5408, 0x540c)}`,
      notes: [],
    });
    const read = await extractText(
      { originalname: 'a.docx', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toBe(
      `caf${String.fromCharCode(0xe9)} ${squareMetre} 5${euro} ${String.fromCharCode(0x5408, 0x540c)}`,
    );
  });

  it('cuts a text that is too long, and says so once', async () => {
    const long = 'a'.repeat(MAX_TEXT_CHARS + 5);
    const { readers } = fakeReaders({ text: long, notes: [] });
    const read = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toHaveLength(MAX_TEXT_CHARS);
    expect(read.notes).toEqual([LONG_DOCUMENT_NOTE]);

    const again = fakeReaders({ text: long, notes: [LONG_DOCUMENT_NOTE] });
    const second = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      again.readers,
    );
    expect(second.notes).toEqual([LONG_DOCUMENT_NOTE]);
  });

  it('does not cut a text that is exactly as long as the limit', async () => {
    const { readers } = fakeReaders({
      text: 'a'.repeat(MAX_TEXT_CHARS),
      notes: [],
    });
    const read = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toHaveLength(MAX_TEXT_CHARS);
    expect(read.notes).toEqual([]);
  });

  it('turns the ligatures at the ends of the range into plain letters too', async () => {
    const { readers } = fakeReaders({
      text: `${String.fromCharCode(0xfb00)} ${String.fromCharCode(0xfb06)} ${String.fromCharCode(0xfb50)} ${String.fromCharCode(0xfe70)} ${String.fromCharCode(0xfefc)}`,
      notes: [],
    });
    const read = await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(read.text).toBe(
      `ff st ${String.fromCharCode(0x671)}  ${String.fromCharCode(0x64b)} ${String.fromCharCode(0x644, 0x627)}`,
    );
  });

  it('does not change the notes of the reader', async () => {
    const notes = ['one'];
    const { readers } = fakeReaders({
      text: 'a'.repeat(MAX_TEXT_CHARS + 1),
      notes,
    });
    await extractText(
      { originalname: 'a.pdf', buffer: Buffer.from('x') },
      readers,
    );
    expect(notes).toEqual(['one']);
  });

  it('reads a real .docx file with the real Word reader', async () => {
    const buffer = makeDocx(
      paragraph('SERVICE AGREEMENT') + paragraph('1. Liability.'),
    );
    const read = await extractText({ originalname: 'contract.docx', buffer });
    expect(read).toEqual({
      text: 'SERVICE AGREEMENT\n1. Liability.\n',
      notes: [],
    });
  });

  it('refuses a .docx file that is not a real one', async () => {
    const error = await failure(
      extractText({
        originalname: 'fake.docx',
        buffer: Buffer.from('just some text'),
      }),
    );
    expect(error.kind).toBe('unreadable');
  });
});
