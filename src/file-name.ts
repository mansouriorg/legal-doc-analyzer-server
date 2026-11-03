// Puts the name of an uploaded file right.
//
// A browser sends the name of a file as UTF-8. The package that reads the
// upload (multer, through busboy) can read it as Latin-1 instead. Then a name
// with an accent, or with Arabic or Chinese letters, arrives as strange
// characters. This turns such a name back into the real one. A name that is
// already right is returned as it is.
//
// How it tells: a character above U+00FF cannot come from a Latin-1 reading,
// so such a name is already right. Otherwise the characters are taken as the
// bytes they stand for and read as UTF-8. If those bytes are not valid UTF-8,
// the name was right (for example a real "e" with an accent).
export function repairFileName(name: string): string {
  for (const character of name) {
    if ((character.codePointAt(0) ?? 0) > 0xff) {
      return name;
    }
  }
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes(String.fromCharCode(0xfffd)) ? name : decoded;
}
