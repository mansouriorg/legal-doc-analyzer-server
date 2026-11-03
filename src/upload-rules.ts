// Rules for the file a user may upload to POST /analyze.
// The client checks similar rules in the browser, but only this check on the
// server can be trusted, because anything done in the browser can be bypassed.

export const MAX_UPLOAD_MB = 10;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx'];

// The parts of an uploaded file (as multer hands it over) that we look at.
export interface UploadedDocument {
  originalname: string;
  size: number;
  buffer: Buffer;
}

// A .docx file is a zip file, and it starts with the letters PK.
const ZIP_START = [0x50, 0x4b, 0x03, 0x04];
// A .doc file is an old Office file, and it starts with these 8 bytes.
const OLD_OFFICE_START = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

// True when the first bytes of the file are the ones a real file of this type has.
// This does not prove the file is a valid or safe document, only that it is not
// an obvious fake (for example a program that was renamed to contract.pdf).
function looksLikeItsType(extension: string, buffer: Buffer): boolean {
  if (extension === '.pdf') {
    // The PDF standard allows a little junk before the header, so look in the first 1024 bytes.
    return buffer.subarray(0, 1024).includes('%PDF-');
  }
  if (extension === '.docx') {
    return startsWith(buffer, ZIP_START);
  }
  return startsWith(buffer, OLD_OFFICE_START);
}

// Returns null when the file is fine, otherwise a message that can be shown to the user.
export function validateUpload(file: UploadedDocument): string | null {
  const lowerName = file.originalname.toLowerCase();
  const extension = ALLOWED_EXTENSIONS.find((allowed) =>
    lowerName.endsWith(allowed),
  );

  if (extension === undefined) {
    return `"${file.originalname}" is not a PDF or Word document. Please choose a .pdf, .doc or .docx file.`;
  }

  if (file.size === 0) {
    return `"${file.originalname}" is empty. Please choose a different file.`;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.originalname}" is larger than the limit of ${MAX_UPLOAD_MB} MB. Please choose a smaller file.`;
  }

  if (looksLikeItsType(extension, file.buffer) === false) {
    return `"${file.originalname}" does not look like a real ${extension} file. Please choose a different file.`;
  }

  return null;
}
