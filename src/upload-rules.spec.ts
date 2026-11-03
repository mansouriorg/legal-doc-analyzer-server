import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  validateUpload,
  type UploadedDocument,
} from './upload-rules';

const pdfStart = Buffer.from('%PDF-1.7\n%%EOF');
const zipStart = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const oldOfficeStart = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00,
]);

function file(
  originalname: string,
  buffer: Buffer,
  size = buffer.length,
): UploadedDocument {
  return { originalname, size, buffer };
}

describe('validateUpload: file types', () => {
  it('accepts a pdf, a docx and a doc that start like real files', () => {
    expect(validateUpload(file('contract.pdf', pdfStart))).toBeNull();
    expect(validateUpload(file('contract.docx', zipStart))).toBeNull();
    expect(validateUpload(file('contract.doc', oldOfficeStart))).toBeNull();
  });

  it('ignores upper and lower case in the file name', () => {
    expect(validateUpload(file('CONTRACT.PDF', pdfStart))).toBeNull();
    expect(validateUpload(file('Contract.DocX', zipStart))).toBeNull();
  });

  it('lists exactly the extensions the client accepts', () => {
    expect(ALLOWED_EXTENSIONS).toEqual(['.pdf', '.doc', '.docx']);
  });

  it('rejects other file types and names the file in the message', () => {
    const message = validateUpload(file('notes.txt', Buffer.from('hello')));
    expect(message).toContain('"notes.txt" is not a PDF or Word document');
  });

  it('rejects a program hidden behind a pdf name', () => {
    expect(validateUpload(file('invoice.pdf.exe', pdfStart))).not.toBeNull();
  });

  it('rejects a name that only ends with the letters pdf', () => {
    expect(validateUpload(file('pdf', pdfStart))).not.toBeNull();
    expect(validateUpload(file('contractpdf', pdfStart))).not.toBeNull();
  });
});

describe('validateUpload: what is inside the file', () => {
  it('rejects a .pdf that is really text', () => {
    const message = validateUpload(file('fake.pdf', Buffer.from('just text')));
    expect(message).toContain('does not look like a real .pdf file');
  });

  it('accepts a pdf with a little junk before the header', () => {
    const body = Buffer.concat([Buffer.from('\n\n  '), pdfStart]);
    expect(validateUpload(file('odd.pdf', body))).toBeNull();
  });

  it('rejects a pdf whose header is far into the file', () => {
    const body = Buffer.concat([Buffer.alloc(2000, 0x20), pdfStart]);
    expect(validateUpload(file('late.pdf', body))).not.toBeNull();
  });

  it('rejects a .docx that is really a pdf, and a .doc that is really a zip', () => {
    expect(validateUpload(file('wrong.docx', pdfStart))).not.toBeNull();
    expect(validateUpload(file('wrong.doc', zipStart))).not.toBeNull();
  });
});

describe('validateUpload: size', () => {
  it('states a limit of 10 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a file of exactly 10 MB', () => {
    expect(
      validateUpload(file('big.pdf', pdfStart, MAX_UPLOAD_BYTES)),
    ).toBeNull();
  });

  it('rejects a file one byte over 10 MB', () => {
    const message = validateUpload(
      file('big.pdf', pdfStart, MAX_UPLOAD_BYTES + 1),
    );
    expect(message).toContain('"big.pdf" is larger than the limit of 10 MB');
  });

  it('rejects an empty file', () => {
    const message = validateUpload(file('empty.pdf', Buffer.alloc(0)));
    expect(message).toContain('"empty.pdf" is empty');
  });

  it('reports the wrong type first when a file is both the wrong type and too big', () => {
    const message = validateUpload(
      file('movie.mp4', pdfStart, 500 * 1024 * 1024),
    );
    expect(message).toContain('not a PDF or Word document');
  });
});
