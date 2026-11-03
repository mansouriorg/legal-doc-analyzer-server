import { join } from 'path';
import { DEFAULT_ENV_FILE, loadEnvFileIfPresent } from './env-file';

const sample = join(__dirname, '..', 'test', 'fixtures', 'settings-sample.txt');

describe('loadEnvFileIfPresent', () => {
  it('looks for a file named .env by default', () => {
    expect(DEFAULT_ENV_FILE).toBe('.env');
  });

  it('returns false and changes nothing when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'this' };
    expect(loadEnvFileIfPresent(join(__dirname, 'no-such-file'), env)).toBe(
      false,
    );
    expect(env).toEqual({ KEEP: 'this' });
  });

  it('copies the values of the file into the environment', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFileIfPresent(sample, env)).toBe(true);
    expect(env.SAMPLE_ONE).toBe('hello');
    expect(env.SAMPLE_EMPTY).toBe('');
  });

  it('removes the quotes around a value and ignores comment lines', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFileIfPresent(sample, env);
    expect(env.SAMPLE_TWO).toBe('two words');
    expect(Object.keys(env).sort()).toEqual([
      'SAMPLE_EMPTY',
      'SAMPLE_ONE',
      'SAMPLE_TWO',
    ]);
  });

  it('lets a value that is already set win over the file', () => {
    const env: NodeJS.ProcessEnv = { SAMPLE_ONE: 'from the shell' };
    loadEnvFileIfPresent(sample, env);
    expect(env.SAMPLE_ONE).toBe('from the shell');
    expect(env.SAMPLE_TWO).toBe('two words');
  });

  it('does not touch the real environment of the process when it is given another one', () => {
    loadEnvFileIfPresent(sample, {});
    expect(process.env.SAMPLE_ONE).toBeUndefined();
  });

  it('does not hide other problems: a folder instead of a file is an error', () => {
    expect(() => loadEnvFileIfPresent(__dirname, {})).toThrow();
  });
});
