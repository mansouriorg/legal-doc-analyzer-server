import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// Folders for the tests that write files. They are made inside the project, in
// the folder .tmp-tests (which git ignores), so that a test never writes
// outside the project. Each test run gets its own folder and removes it.
const ROOT = join(__dirname, '..', '..', '.tmp-tests');

export async function makeTempDir(): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  return mkdtemp(join(ROOT, 'run-'));
}

// Removes a folder made by makeTempDir, with everything in it. It refuses any
// other folder, so a wrong path can never delete something that matters.
export async function removeTempDir(dir: string): Promise<void> {
  // resolve() first, so that a path with ".." in it is judged by where it leads.
  const target = resolve(dir);
  if (target.startsWith(`${ROOT}${sep}run-`) === false) {
    throw new Error(
      `Refusing to remove a folder that is not a test folder: ${dir}`,
    );
  }
  await rm(target, { recursive: true, force: true });
}
