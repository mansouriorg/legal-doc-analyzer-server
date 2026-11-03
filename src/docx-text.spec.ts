import {
  documentXml,
  makeDocx,
  makeZip,
  paragraph,
  WORD_NAMESPACE,
} from '../test/helpers/make-docx';
import { DOCX_LIMITS, readDocxText } from './docx-text';
import {
  ExtractionError,
  LONG_DOCUMENT_NOTE,
  MAX_TEXT_CHARS,
} from './extraction';

function thrown(action: () => unknown): ExtractionError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExtractionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an ExtractionError, but nothing was thrown');
}

const bang = String.fromCharCode(33);
const eAcute = String.fromCharCode(0xe9);

describe('readDocxText', () => {
  it('reads the paragraphs of a document, one per line', () => {
    const docx = makeDocx(
      paragraph('SERVICE AGREEMENT') + paragraph('1. Term and renewal.'),
    );
    expect(readDocxText(docx)).toEqual({
      text: 'SERVICE AGREEMENT\n1. Term and renewal.\n',
      notes: [],
    });
  });

  it('reads a file whose parts are not compressed', () => {
    const docx = makeDocx(paragraph('Stored text.'), 'stored');
    expect(readDocxText(docx).text).toBe('Stored text.\n');
  });

  it('finds the text part among other parts, and only the part with exactly that name', () => {
    const docx = makeZip([
      { name: 'word/document.xml.bak', data: documentXml(paragraph('Old')) },
      { name: 'word/_rels/document.xml.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: documentXml(paragraph('Real')) },
      { name: 'word/styles.xml', data: '<styles/>' },
    ]);
    expect(readDocxText(docx).text).toBe('Real\n');
  });

  it('finds the end of a zip file that has a comment', () => {
    const entries = [
      { name: 'word/document.xml', data: documentXml(paragraph('Comment')) },
    ];
    const docx = makeZip(entries, { comment: 'x'.repeat(5000) });
    expect(readDocxText(docx).text).toBe('Comment\n');
  });

  it('joins the pieces of a paragraph: runs, tabs, line breaks and hyphens', () => {
    const body =
      '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/><w:t>B</w:t></w:r>' +
      '<w:r><w:br/><w:t>C</w:t></w:r><w:r><w:noBreakHyphen/><w:t>D</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('A\tB\nC-D\n');
  });

  it('does not take a tab stop of a paragraph for a tab', () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>X</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('X\n');
  });

  it('reads the cells of a table in order', () => {
    const body =
      '<w:tbl><w:tr><w:tc>' +
      paragraph('Party') +
      '</w:tc><w:tc>' +
      paragraph('Supplier') +
      '</w:tc></w:tr></w:tbl>';
    expect(readDocxText(makeDocx(body)).text).toBe('Party\nSupplier\n');
  });

  it('decodes the characters that are written as entities', () => {
    const body =
      '<w:p><w:r><w:t>Fish &amp; Chips &lt;b&gt; &quot;x&quot; &apos;y&apos; ' +
      '&#233;&#xE9;&#0;&#xD800;&#x110000; &nbsp;</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe(
      `Fish & Chips <b> "x" 'y' ${eAcute}${eAcute} &nbsp;\n`,
    );
  });

  it('leaves out deleted text and field codes, and says there are tracked changes', () => {
    const body =
      '<w:p><w:del><w:r><w:delText>old words</w:delText></w:r></w:del>' +
      '<w:ins><w:r><w:t>new words</w:t></w:r></w:ins>' +
      '<w:r><w:instrText> PAGEREF page1 </w:instrText></w:r></w:p>';
    const read = readDocxText(makeDocx(body));
    expect(read.text).toBe('new words\n');
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toContain('tracked changes');
    expect(read.notes[0]).toContain('deleted text is left out');
  });

  it('keeps hidden text, and says that it is there', () => {
    const body =
      '<w:p><w:r><w:t>Shown. </w:t></w:r>' +
      '<w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden words.</w:t></w:r></w:p>';
    const read = readDocxText(makeDocx(body));
    expect(read.text).toBe('Shown. Hidden words.\n');
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toContain('hidden in Word');
  });

  it('does not report hidden text when the hiding is switched off or only hides a paragraph mark', () => {
    const body =
      '<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>A</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>B</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>C</w:t></w:r></w:p>';
    const read = readDocxText(makeDocx(body));
    expect(read.text).toBe('A\nB\nC\n');
    expect(read.notes).toEqual([]);
  });

  it('reads a text box once, and not also its copy for old programs', () => {
    const body =
      '<mc:AlternateContent><mc:Choice Requires="wps">' +
      paragraph('Boxed') +
      '</mc:Choice><mc:Fallback>' +
      paragraph('Old copy') +
      '</mc:Fallback></mc:AlternateContent>' +
      paragraph('After');
    expect(readDocxText(makeDocx(body)).text).toBe('Boxed\nAfter\n');
  });

  it('reads a file that uses another prefix for the Word tags', () => {
    const xml = `<root xmlns:x="${WORD_NAMESPACE}"><x:p><x:r><x:t>Other prefix</x:t></x:r></x:p></root>`;
    const docx = makeZip([{ name: 'word/document.xml', data: xml }]);
    expect(readDocxText(docx).text).toBe('Other prefix\n');
  });

  it('uses the prefix w when the file does not say which prefix it uses', () => {
    const xml = '<root><w:p><w:r><w:t>Text</w:t></w:r></w:p></root>';
    const docx = makeZip([{ name: 'word/document.xml', data: xml }]);
    expect(readDocxText(docx).text).toBe('Text\n');
  });

  it('ignores the XML declaration and comments', () => {
    const comment = `<${bang}-- <w:t>not text</w:t> -->`;
    const docx = makeDocx(comment + paragraph('Real'));
    expect(readDocxText(docx).text).toBe('Real\n');
  });

  it('does not take a part whose name only ends with the right name', () => {
    const docx = makeZip([
      {
        name: 'extra/word/document.xml',
        data: documentXml(paragraph('Wrong')),
      },
      { name: 'word/document.xml', data: documentXml(paragraph('Right')) },
    ]);
    expect(readDocxText(docx).text).toBe('Right\n');
  });

  it('reads parts that have extra fields and comments in their headers', () => {
    const docx = makeZip([
      {
        name: 'first.xml',
        data: '<a/>',
        extraBytes: 12,
        comment: 'a comment of the first part',
      },
      {
        name: 'word/document.xml',
        data: documentXml(paragraph('With extras')),
        extraBytes: 40,
        comment: 'another comment',
      },
    ]);
    expect(readDocxText(docx).text).toBe('With extras\n');
  });

  it('reads the characters of other languages that are written in the file itself', () => {
    const text = `Caf${eAcute} ${String.fromCharCode(0x5408, 0x540c)} ${String.fromCharCode(0x639, 0x642, 0x62f)}`;
    expect(readDocxText(makeDocx(paragraph(text))).text).toBe(`${text}\n`);
  });

  it('reads a carriage return as a line break, and a tab written with an end tag as one tab', () => {
    const body =
      '<w:p><w:r><w:t>A</w:t><w:cr/><w:t>B</w:t><w:tab></w:tab><w:t>C</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('A\nB\tC\n');
  });

  it('knows that an empty paragraph property list does not hide the tabs that follow', () => {
    const body = '<w:p><w:pPr/><w:r><w:tab/><w:t>X</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('\tX\n');
  });

  it('reads the Word tags of the strict format', () => {
    const xml =
      '<root xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:p><x:r><x:t>Strict</x:t></x:r></x:p></root>';
    const docx = makeZip([{ name: 'word/document.xml', data: xml }]);
    expect(readDocxText(docx).text).toBe('Strict\n');
  });

  it('reports tracked changes for an insertion alone and for a deletion alone', () => {
    const inserted = '<w:p><w:ins><w:r><w:t>New</w:t></w:r></w:ins></w:p>';
    const deleted =
      '<w:p><w:del><w:r><w:delText>Old</w:delText></w:r></w:del></w:p>';
    expect(readDocxText(makeDocx(inserted)).notes).toHaveLength(1);
    expect(readDocxText(makeDocx(deleted)).notes).toHaveLength(1);
    expect(readDocxText(makeDocx(deleted)).text).toBe('\n');
  });

  it('reports hidden text that is hidden in the other way Word has, and not one that is switched off', () => {
    const special =
      '<w:p><w:r><w:rPr><w:specVanish/></w:rPr><w:t>Hidden</w:t></w:r></w:p>';
    const off =
      '<w:p><w:r><w:rPr><w:vanish w:val="off"/></w:rPr><w:t>Shown</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(special)).notes).toHaveLength(1);
    expect(readDocxText(makeDocx(off)).notes).toEqual([]);
  });

  it('keeps reading after a copy for old programs that is closed on itself', () => {
    const body = '<mc:Fallback/>' + paragraph('Still read');
    expect(readDocxText(makeDocx(body)).text).toBe('Still read\n');
  });

  it('finds the end of a zip file whose comment has the longest length possible', () => {
    const docx = makeZip(
      [{ name: 'word/document.xml', data: documentXml(paragraph('Comment')) }],
      { comment: 'x'.repeat(65535) },
    );
    expect(readDocxText(docx).text).toBe('Comment\n');
  });

  it('tells tab stops from tabs, and hidden text from a hidden paragraph mark, after the first paragraph too', () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>' +
      '<w:p><w:r><w:tab/><w:t>Two</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden</w:t></w:r></w:p>';
    const read = readDocxText(makeDocx(body));
    expect(read.text).toBe('One\n\tTwoHidden\n');
    expect(read.notes).toHaveLength(1);
  });

  it('is not confused by an end tag of paragraph properties that has no start tag', () => {
    const body =
      '</w:pPr><w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>X</w:t></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('X\n');
  });

  it('does not read what follows an empty text tag as text', () => {
    const body =
      '<w:p><w:r><w:t/><w:instrText> FIELD </w:instrText></w:r></w:p>';
    expect(readDocxText(makeDocx(body)).text).toBe('\n');
  });

  it('counts line breaks too when it applies the limit, and does not cut a text that is exactly as long as the limit', () => {
    const limits = { ...DOCX_LIMITS, maxChars: 20 };
    const exact = readDocxText(makeDocx(paragraph('a'.repeat(19))), limits);
    expect(exact.text).toBe(`${'a'.repeat(19)}\n`);
    expect(exact.notes).toEqual([]);
    const over = readDocxText(makeDocx(paragraph('a'.repeat(20))), limits);
    expect(over.text).toBe('a'.repeat(20));
    expect(over.notes).toEqual([LONG_DOCUMENT_NOTE]);
    const empty = readDocxText(
      makeDocx('<w:p/><w:p></w:p>'.repeat(30)),
      limits,
    );
    expect(empty.text.length).toBeLessThanOrEqual(20);
    expect(empty.notes).toEqual([LONG_DOCUMENT_NOTE]);
  });

  it('has the limits that the README names', () => {
    expect(DOCX_LIMITS).toEqual({
      maxXmlBytes: 20 * 1024 * 1024,
      maxChars: 200000,
    });
    expect(MAX_TEXT_CHARS).toBe(200000);
  });

  it('stops when the text is longer than the limit, and says so', () => {
    let body = '';
    for (let index = 0; index < 100; index++) {
      body += paragraph(`Line number ${index}`);
    }
    const limits = { ...DOCX_LIMITS, maxChars: 50 };
    const read = readDocxText(makeDocx(body), limits);
    expect(read.text.length).toBeLessThanOrEqual(50);
    expect(read.text).toContain('Line number 0');
    expect(read.notes).toEqual([LONG_DOCUMENT_NOTE]);
  });
});

describe('readDocxText with files that cannot be read', () => {
  it('refuses a file that is not a zip file', () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('PK'),
      Buffer.from('this is not a zip file, it is only some text'),
    ]) {
      const error = thrown(() => readDocxText(bytes));
      expect(error.kind).toBe('unreadable');
      expect(error.message).toContain('could not be read');
    }
  });

  it('refuses a zip file without the text part', () => {
    const docx = makeZip([{ name: 'hello.txt', data: 'Hello' }]);
    const error = thrown(() => readDocxText(docx));
    expect(error.kind).toBe('unreadable');
    expect(error.message).toContain('word/document.xml');
    expect(error.message).toContain('may not be a Word document');
  });

  it('refuses a part that uses a compression method it does not know', () => {
    const docx = makeZip([
      {
        name: 'word/document.xml',
        data: documentXml(paragraph('X')),
        method: 'stored',
        methodCode: 99,
      },
    ]);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('refuses a part whose compressed data is damaged', () => {
    const docx = makeZip([
      {
        name: 'word/document.xml',
        data: 'this is not compressed data at all, it only claims to be',
        method: 'stored',
        methodCode: 8,
      },
    ]);
    const error = thrown(() => readDocxText(docx));
    expect(error.kind).toBe('unreadable');
    expect(error.message).toContain('could not be read');
  });

  it('refuses a part that unpacks to more than the limit (a zip bomb)', () => {
    const docx = makeZip([
      { name: 'word/document.xml', data: Buffer.alloc(200000, 0x61) },
    ]);
    const limits = { ...DOCX_LIMITS, maxXmlBytes: 1000 };
    const error = thrown(() => readDocxText(docx, limits));
    expect(error.kind).toBe('unreadable');
    expect(error.message).toContain('too large');
  });

  it('refuses a part that is stored and larger than the limit', () => {
    const docx = makeZip([
      {
        name: 'word/document.xml',
        data: Buffer.alloc(5000, 0x61),
        method: 'stored',
      },
    ]);
    const limits = { ...DOCX_LIMITS, maxXmlBytes: 1000 };
    expect(thrown(() => readDocxText(docx, limits)).message).toContain(
      'too large',
    );
  });

  it('accepts a part whose unpacked size is exactly the limit', () => {
    const xml = documentXml(paragraph('Small'));
    const docx = makeZip([{ name: 'word/document.xml', data: xml }]);
    const limits = { ...DOCX_LIMITS, maxXmlBytes: Buffer.byteLength(xml) };
    expect(readDocxText(docx, limits).text).toBe('Small\n');
    const tooSmall = {
      ...DOCX_LIMITS,
      maxXmlBytes: Buffer.byteLength(xml) - 1,
    };
    expect(thrown(() => readDocxText(docx, tooSmall)).message).toContain(
      'too large',
    );
  });

  it('refuses a zip64 file, which is not supported', () => {
    const docx = makeDocx(paragraph('X'));
    docx.writeUInt16LE(0xffff, docx.length - 22 + 10);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('refuses a file whose list of parts points outside the file', () => {
    for (const start of [0x7ffffff0, 0xffffffff]) {
      const docx = makeDocx(paragraph('X'));
      docx.writeUInt32LE(start, docx.length - 22 + 16);
      expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
    }
  });

  it('refuses a file whose list of parts is damaged', () => {
    const docx = makeZip([
      { name: 'word/document.xml', data: documentXml(paragraph('X')) },
    ]);
    const directoryStart = docx.readUInt32LE(docx.length - 22 + 16);
    docx.writeUInt32LE(0x12345678, directoryStart);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('refuses a stored part that is announced larger than the file', () => {
    const docx = makeZip([
      {
        name: 'word/document.xml',
        data: documentXml(paragraph('X')),
        method: 'stored',
      },
    ]);
    const directoryStart = docx.readUInt32LE(docx.length - 22 + 16);
    docx.writeUInt32LE(docx.length * 2, directoryStart + 20);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('refuses a compression method it does not support, even when the data could be read', () => {
    const docx = makeZip([
      {
        name: 'word/document.xml',
        data: documentXml(paragraph('X')),
        methodCode: 9,
      },
    ]);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('accepts a stored part of exactly the limit and refuses one byte more', () => {
    const xml = documentXml(paragraph('Stored'));
    const size = Buffer.byteLength(xml);
    const docx = makeZip([
      { name: 'word/document.xml', data: xml, method: 'stored' },
    ]);
    const exact = { ...DOCX_LIMITS, maxXmlBytes: size };
    const smaller = { ...DOCX_LIMITS, maxXmlBytes: size - 1 };
    expect(readDocxText(docx, exact).text).toBe('Stored\n');
    expect(thrown(() => readDocxText(docx, smaller)).message).toContain(
      'too large',
    );
  });

  it('refuses a part when its header is not where the list of parts says', () => {
    const docx = makeZip([
      { name: 'word/document.xml', data: documentXml(paragraph('X')) },
    ]);
    const end = docx.length - 22;
    const directoryStart = docx.readUInt32LE(end + 16);
    docx.writeUInt32LE(5, directoryStart + 42);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('gives the error a name and a kind', () => {
    const error = thrown(() => readDocxText(Buffer.from('not a zip file')));
    expect(error.name).toBe('ExtractionError');
    expect(error).toBeInstanceOf(Error);
  });

  it('refuses a part whose position points outside the file', () => {
    const docx = makeZip([
      { name: 'word/document.xml', data: documentXml(paragraph('X')) },
    ]);
    const end = docx.length - 22;
    const directoryStart = docx.readUInt32LE(end + 16);
    docx.writeUInt32LE(0x7ffffff0, directoryStart + 42);
    expect(thrown(() => readDocxText(docx)).kind).toBe('unreadable');
  });

  it('never fails in another way, however the file is cut off or damaged', () => {
    const docx = makeDocx(paragraph('Some text') + paragraph('More text'));
    const outcomes: string[] = [];
    const attempt = (bytes: Buffer): void => {
      try {
        readDocxText(bytes);
        outcomes.push('read');
      } catch (error) {
        if (error instanceof ExtractionError) {
          outcomes.push('refused');
        } else {
          outcomes.push(`unexpected: ${String(error)}`);
        }
      }
    };
    for (let length = 0; length < docx.length; length++) {
      attempt(docx.subarray(0, length));
    }
    for (let at = 0; at < docx.length; at++) {
      const changed = Buffer.from(docx);
      changed[at] = changed[at] ^ 0xff;
      attempt(changed);
    }
    expect(
      outcomes.filter((outcome) => outcome.startsWith('unexpected')),
    ).toEqual([]);
    expect(outcomes).toContain('refused');
    expect(outcomes).toContain('read');
  });
});
