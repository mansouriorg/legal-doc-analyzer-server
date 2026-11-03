import { inflateRawSync } from 'node:zlib';
import {
  ExtractionError,
  LONG_DOCUMENT_NOTE,
  MAX_TEXT_CHARS,
  type ExtractedText,
} from './extraction';

// Reads the text of a .docx file. A .docx file is a zip file, and the text of
// the document is in its part "word/document.xml". Both are read here with a
// few lines of code and node:zlib, so that no package is needed.
//
// The file comes from a person we do not know, so the reading is careful:
// every position in the zip file is checked before it is used, only one part
// is unpacked, the unpacked size has a limit (a small zip file can unpack to
// gigabytes), and the XML is read tag by tag, without an XML parser. No tag
// can pull in another file or expand into a huge text.

export interface DocxLimits {
  maxXmlBytes: number;
  maxChars: number;
}

export const DOCX_LIMITS: DocxLimits = {
  maxXmlBytes: 20 * 1024 * 1024,
  maxChars: MAX_TEXT_CHARS,
};

const DOCUMENT_PART = 'word/document.xml';

const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;
const ENTRY_SIGNATURE = 0x02014b50;
const ENTRY_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const STORED = 0;
const DEFLATED = 8;

const DAMAGED_MESSAGE =
  'The Word file could not be read. It may be damaged. Please save it again as .docx or as a PDF.';

function damaged(): ExtractionError {
  return new ExtractionError('unreadable', DAMAGED_MESSAGE);
}

function tooLarge(): ExtractionError {
  return new ExtractionError(
    'unreadable',
    'The text of the Word file is too large to read.',
  );
}

function isTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
  );
}

// The end record of a zip file is at the end, followed only by a comment of
// at most 65535 bytes.
function findEndRecord(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - END_SIZE - MAX_ZIP_COMMENT);
  for (let at = zip.length - END_SIZE; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === END_SIGNATURE) {
      return at;
    }
  }
  return -1;
}

function unpack(method: number, packed: Buffer, maxBytes: number): Buffer {
  if (method === STORED) {
    if (packed.length > maxBytes) {
      throw tooLarge();
    }
    return packed;
  }
  if (method !== DEFLATED) {
    throw damaged();
  }
  try {
    return inflateRawSync(packed, { maxOutputLength: maxBytes });
  } catch (error) {
    throw isTooLarge(error) ? tooLarge() : damaged();
  }
}

function findPart(
  zip: Buffer,
  wanted: string,
  maxBytes: number,
): Buffer | null {
  const end = findEndRecord(zip);
  if (end < 0) {
    throw damaged();
  }
  const entryCount = zip.readUInt16LE(end + 10);
  const directoryStart = zip.readUInt32LE(end + 16);
  // 0xffff means "see the zip64 record", which is not supported. The same
  // sign in the other fields puts the list of parts far outside the file, and
  // that is refused below.
  if (entryCount === 0xffff) {
    throw damaged();
  }

  let at = directoryStart;
  for (let index = 0; index < entryCount; index++) {
    if (
      at + ENTRY_SIZE > zip.length ||
      zip.readUInt32LE(at) !== ENTRY_SIGNATURE
    ) {
      throw damaged();
    }
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localStart = zip.readUInt32LE(at + 42);
    const name = zip.toString(
      'latin1',
      at + ENTRY_SIZE,
      at + ENTRY_SIZE + nameLength,
    );

    if (name === wanted) {
      if (
        localStart + LOCAL_SIZE > zip.length ||
        zip.readUInt32LE(localStart) !== LOCAL_SIGNATURE
      ) {
        throw damaged();
      }
      const dataStart =
        localStart +
        LOCAL_SIZE +
        zip.readUInt16LE(localStart + 26) +
        zip.readUInt16LE(localStart + 28);
      if (dataStart + packedSize > zip.length) {
        throw damaged();
      }
      return unpack(
        method,
        zip.subarray(dataStart, dataStart + packedSize),
        maxBytes,
      );
    }
    at += ENTRY_SIZE + nameLength + extraLength + commentLength;
  }
  return null;
}

// Returns the bytes of one part of a zip file, or null when there is no such
// part. Every other problem is an ExtractionError.
function readZipPart(
  zip: Buffer,
  wanted: string,
  maxBytes: number,
): Buffer | null {
  try {
    return findPart(zip, wanted, maxBytes);
  } catch (error) {
    if (error instanceof ExtractionError) {
      throw error;
    }
    // A position outside the file makes Buffer throw a RangeError.
    throw damaged();
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g,
    (_all, body: string) => {
      if (body[0] !== '#') {
        return ENTITIES[body];
      }
      const code =
        body[1] === 'x'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      const usable =
        code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return usable ? String.fromCodePoint(code) : '';
    },
  );
}

// The two addresses Word files use for the "w:" tags (the usual one and the
// one of the strict format). The prefix is normally "w", but a file may use
// another prefix for the same address.
const WORD_ADDRESS =
  /xmlns:([A-Za-z_][\w.-]*)="(?:http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/wordprocessingml\/main)"/;

function wordPrefix(xml: string): string {
  const found = WORD_ADDRESS.exec(xml.slice(0, 50000));
  return found === null ? 'w' : found[1];
}

// A tag, a piece of text, or a "<" that has no ">" after it.
const TOKENS = /<[^>]*>|[^<]+|</g;
const TAG = /^<(\/?)([^\s/>]+)([^>]*)>$/;
const VALUE_OFF = /\bval="(?:0|false|off)"/;

interface XmlText {
  text: string;
  hidden: boolean;
  tracked: boolean;
  cut: boolean;
}

// Collects the text of the "w:t" tags and puts a line break after each paragraph.
function xmlToText(xml: string, maxChars: number): XmlText {
  const p = wordPrefix(xml);
  const names = {
    text: `${p}:t`,
    paragraph: `${p}:p`,
    paragraphProps: `${p}:pPr`,
    tab: `${p}:tab`,
    breakLine: `${p}:br`,
    carriageReturn: `${p}:cr`,
    hyphen: `${p}:noBreakHyphen`,
    hidden: `${p}:vanish`,
    hiddenToo: `${p}:specVanish`,
    deleted: `${p}:del`,
    inserted: `${p}:ins`,
  };

  const parts: string[] = [];
  let length = 0;
  let inText = false;
  let fallbackDepth = 0;
  let propsDepth = 0;
  let hidden = false;
  let tracked = false;
  let cut = false;

  const add = (piece: string): void => {
    parts.push(piece);
    length += piece.length;
    if (length > maxChars) {
      cut = true;
    }
  };

  for (const match of xml.matchAll(TOKENS)) {
    if (cut) {
      break;
    }
    const token = match[0];
    if (token[0] !== '<') {
      if (inText && fallbackDepth === 0) {
        add(decodeEntities(token));
      }
      continue;
    }

    const tag = TAG.exec(token);
    if (tag === null) {
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2];
    const selfClosing = tag[3].endsWith('/');

    // A text box is written twice: once in "mc:Choice" and once in the
    // "mc:Fallback" for old programs. Only the first is read.
    if (name.endsWith(':Fallback')) {
      if (closing) {
        fallbackDepth = Math.max(0, fallbackDepth - 1);
      } else if (selfClosing === false) {
        fallbackDepth += 1;
      }
      continue;
    }
    if (fallbackDepth > 0) {
      continue;
    }

    if (name === names.text) {
      inText = closing === false && selfClosing === false;
    } else if (name === names.paragraph) {
      if (closing) {
        add('\n');
      }
    } else if (name === names.paragraphProps) {
      if (closing) {
        propsDepth = Math.max(0, propsDepth - 1);
      } else if (selfClosing === false) {
        propsDepth += 1;
      }
    } else if (closing) {
      continue;
    } else if (name === names.tab) {
      // Inside the properties of a paragraph, "w:tab" is a tab stop and not a tab character.
      if (propsDepth === 0) {
        add('\t');
      }
    } else if (name === names.breakLine || name === names.carriageReturn) {
      add('\n');
    } else if (name === names.hyphen) {
      add('-');
    } else if (name === names.hidden || name === names.hiddenToo) {
      // In the properties of a paragraph it only hides the paragraph mark.
      if (propsDepth === 0 && VALUE_OFF.test(tag[3]) === false) {
        hidden = true;
      }
    } else if (name === names.deleted || name === names.inserted) {
      tracked = true;
    }
  }

  const text = parts.join('');
  return { text: cut ? text.slice(0, maxChars) : text, hidden, tracked, cut };
}

export function readDocxText(
  buffer: Buffer,
  limits: DocxLimits = DOCX_LIMITS,
): ExtractedText {
  const part = readZipPart(buffer, DOCUMENT_PART, limits.maxXmlBytes);
  if (part === null) {
    throw new ExtractionError(
      'unreadable',
      'The file has no document text (word/document.xml), so it may not be a Word document.',
    );
  }

  const read = xmlToText(part.toString('utf8'), limits.maxChars);
  const notes: string[] = [];
  if (read.tracked) {
    notes.push(
      'The document contains tracked changes. It was read as if every change was accepted: deleted text is left out.',
    );
  }
  if (read.hidden) {
    notes.push(
      'The document contains text that is hidden in Word (it is not shown on the page). It was read like the rest of the text, so read this analysis with care.',
    );
  }
  if (read.cut) {
    notes.push(LONG_DOCUMENT_NOTE);
  }
  return { text: read.text, notes };
}
