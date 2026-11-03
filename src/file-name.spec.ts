import { repairFileName } from './file-name';

// The names are written with character codes, so that this file stays plain ASCII.
const eAcute = String.fromCharCode(0xe9);
const arabicName = String.fromCharCode(0x639, 0x642, 0x62f);
const chineseName = String.fromCharCode(0x5408, 0x540c);

// What multer gives when it reads a UTF-8 name as Latin-1.
function asLatin1(name: string): string {
  return Buffer.from(name, 'utf8').toString('latin1');
}

describe('repairFileName', () => {
  it('does not change a plain ASCII name', () => {
    expect(repairFileName('contract.pdf')).toBe('contract.pdf');
    expect(repairFileName('')).toBe('');
  });

  it('puts back a name with an accent that was read as Latin-1', () => {
    const right = `soci${eAcute}t${eAcute}.pdf`;
    const wrong = asLatin1(right);
    expect(wrong).not.toBe(right);
    expect(repairFileName(wrong)).toBe(right);
  });

  it('puts back an Arabic name that was read as Latin-1', () => {
    const right = `${arabicName}.docx`;
    expect(repairFileName(asLatin1(right))).toBe(right);
  });

  it('puts back a Chinese name that was read as Latin-1', () => {
    const right = `${chineseName}.pdf`;
    expect(repairFileName(asLatin1(right))).toBe(right);
  });

  it('puts back a name with a character outside the first plane', () => {
    const right = `a${String.fromCodePoint(0x1f4c4)}.pdf`;
    expect(repairFileName(asLatin1(right))).toBe(right);
  });

  it('does not change an Arabic or Chinese name that is already right', () => {
    expect(repairFileName(`${arabicName}.docx`)).toBe(`${arabicName}.docx`);
    expect(repairFileName(`${chineseName}.pdf`)).toBe(`${chineseName}.pdf`);
  });

  it('does not change a Latin-1 name that is already right', () => {
    const right = `soci${eAcute}t${eAcute}.pdf`;
    expect(repairFileName(right)).toBe(right);
    expect(repairFileName(`${eAcute}.pdf`)).toBe(`${eAcute}.pdf`);
  });

  it('does not change a name that mixes right and wrong characters', () => {
    const mixed = `${arabicName}${asLatin1(`${eAcute}`)}.pdf`;
    expect(repairFileName(mixed)).toBe(mixed);
  });

  it('does not change a name when the replacement character is in it', () => {
    const name = `a${String.fromCharCode(0xfffd)}b.pdf`;
    expect(repairFileName(name)).toBe(name);
  });

  it('repairing twice gives the same name', () => {
    const right = `soci${eAcute}t${eAcute}.pdf`;
    const once = repairFileName(asLatin1(right));
    expect(repairFileName(once)).toBe(once);
  });
});
