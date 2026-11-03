import { deflateRawSync } from 'node:zlib';

// Builds small zip files and Word files for tests, without any package.

const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE.push(c >>> 0);
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  // Default: deflated, as in a real Word file.
  method?: 'stored' | 'deflated';
  // Written in the headers in place of the real method, to make a broken file.
  methodCode?: number;
  // Zero bytes added as an extra field to the local and the central header, and
  // a comment in the central header, as some programs write them.
  extraBytes?: number;
  comment?: string;
}

export function makeZip(
  entries: ZipEntry[],
  options: { comment?: string } = {},
): Buffer {
  const pieces: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw =
      typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : entry.data;
    const deflated = (entry.method ?? 'deflated') === 'deflated';
    const packed = deflated ? deflateRawSync(raw) : raw;
    const code = entry.methodCode ?? (deflated ? 8 : 0);
    const name = Buffer.from(entry.name, 'latin1');
    const extra = Buffer.alloc(entry.extraBytes ?? 0);
    const note = Buffer.from(entry.comment ?? '', 'latin1');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(code, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    pieces.push(local, name, extra, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(code, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(note.length, 32);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name, extra, note);

    offset += local.length + name.length + extra.length + packed.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const comment = Buffer.from(options.comment ?? '', 'latin1');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...pieces, directoryBytes, end, comment]);
}

export const WORD_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// One paragraph with one piece of text.
export function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

export function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}</w:body></w:document>`;
}

// A .docx file whose body is the given XML (paragraphs, tables, ...).
export function makeDocx(
  body: string,
  method: 'stored' | 'deflated' = 'deflated',
): Buffer {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      method,
    },
    {
      name: '_rels/.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      method,
    },
    { name: 'word/document.xml', data: documentXml(body), method },
  ]);
}
