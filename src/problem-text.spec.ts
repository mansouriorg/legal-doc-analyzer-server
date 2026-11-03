import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../test/helpers/temp-dir';
import { NOT_SAVED_MESSAGE, StoreError } from './document-store';
import { describeProblem } from './problem-text';

describe('describeProblem', () => {
  it('gives the fixed message of an error of the store', () => {
    expect(describeProblem(new StoreError(NOT_SAVED_MESSAGE))).toBe(
      NOT_SAVED_MESSAGE,
    );
  });

  it('gives the kind and the code of an error of the system, but not its message', () => {
    const noRight = Object.assign(
      new Error("EACCES: permission denied, unlink '/private/place/data/x'"),
      { code: 'EACCES' },
    );
    const text = describeProblem(noRight);
    expect(text).toBe('Error EACCES');
    expect(text).not.toContain('/private/place');
  });

  it('does the same for an error that Node itself made', async () => {
    const root = await makeTempDir();
    try {
      let error: unknown;
      try {
        await readdir(join(root, 'does-not-exist'));
      } catch (problem) {
        error = problem;
      }
      const text = describeProblem(error);
      expect(text).toBe('Error ENOENT');
      expect(text).not.toContain('does-not-exist');
    } finally {
      await removeTempDir(root);
    }
  });

  it('gives only the kind of an error that has no code', () => {
    expect(describeProblem(new TypeError('private detail'))).toBe('TypeError');
  });

  it('gives only the kind when the code does not look like the code of a system error', () => {
    for (const code of [
      'C:\\Users\\me\\secret',
      'eacces',
      'E',
      'A'.repeat(40),
      '',
      5,
    ]) {
      const odd = Object.assign(new Error('private detail'), { code });
      expect(describeProblem(odd)).toBe('Error');
    }
  });

  it('says Error when the name of the error is not a text', () => {
    const odd = new Error('private detail');
    Object.defineProperty(odd, 'name', { value: 5 });
    expect(describeProblem(odd)).toBe('Error');
  });

  it('writes nothing about a value that is not an error', () => {
    const answer = 'an error that is not an Error';
    for (const value of [
      { message: 'private detail', code: 'EACCES' },
      'private detail',
      42,
      null,
      undefined,
    ]) {
      expect(describeProblem(value)).toBe(answer);
    }
  });
});
