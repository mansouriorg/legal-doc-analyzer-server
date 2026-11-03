import { readDocxText } from './docx-text';
import {
  ExtractionError,
  LONG_DOCUMENT_NOTE,
  MAX_TEXT_CHARS,
  type ExtractedText,
} from './extraction';
import { readPdfText } from './pdf-text';

// Reads the text out of an uploaded document: a PDF or a .docx file. POST
// /analyze uses it (see analyze-document.ts).

// The parts of an uploaded file (as multer hands it over) that are used here.
export interface DocumentFile {
  originalname: string;
  buffer: Buffer;
}

export interface TextReaders {
  pdf: (buffer: Buffer) => Promise<ExtractedText>;
  docx: (buffer: Buffer) => ExtractedText;
}

const DEFAULT_READERS: TextReaders = {
  pdf: (buffer) => readPdfText(buffer),
  docx: (buffer) => readDocxText(buffer),
};

// The characters are written as codes, so that this file stays plain ASCII.
function chars(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

// Characters that a PDF holds for the shape of a letter and not for the letter
// itself: the ligatures of Latin letters (such as the one in "fi") and the
// joined forms of Arabic letters. Their compatibility form is the plain
// letters. Other look-alike characters are left as they are, because a quote
// is shown to the person as it was read (for example "m2" must not replace
// the square metre sign).
const SHAPE_FORMS = new RegExp(
  `[${chars(0xfb00)}-${chars(0xfb06)}${chars(0xfb50)}-${chars(0xfdff)}${chars(0xfe70)}-${chars(0xfeff)}]`,
  'g',
);

// Also joins a letter and a separate accent mark into one letter (some
// programs write the text of a PDF that way). That does not change the text.
function plainLetters(text: string): string {
  return text
    .replace(SHAPE_FORMS, (form) => form.normalize('NFKC'))
    .normalize('NFC');
}

export async function extractText(
  file: DocumentFile,
  readers: TextReaders = DEFAULT_READERS,
): Promise<ExtractedText> {
  const lowerName = file.originalname.toLowerCase();
  let read: ExtractedText;
  if (lowerName.endsWith('.pdf')) {
    read = await readers.pdf(file.buffer);
  } else if (lowerName.endsWith('.docx')) {
    read = readers.docx(file.buffer);
  } else if (lowerName.endsWith('.doc')) {
    throw new ExtractionError(
      'unsupported-format',
      `"${file.originalname}" is an old Word file (.doc), which cannot be read yet. Please open it in Word and save it as .docx or as a PDF.`,
    );
  } else {
    throw new ExtractionError(
      'unsupported-format',
      `"${file.originalname}" is not a PDF or Word document. Please choose a .pdf or .docx file.`,
    );
  }

  let text = plainLetters(read.text);
  const notes = [...read.notes];
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    if (notes.includes(LONG_DOCUMENT_NOTE) === false) {
      notes.push(LONG_DOCUMENT_NOTE);
    }
  }
  return { text, notes };
}
