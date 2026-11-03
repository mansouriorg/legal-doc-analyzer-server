import { readFileSync } from 'fs';
import { parseEnv } from 'util';

export const DEFAULT_ENV_FILE = '.env';

// Reads a settings file (by default the .env file in the folder where the
// server is started) and copies its values into `env`.
//
// A value that is already set in `env` wins over the file, so a value given
// in the shell (for example PORT=3002 pnpm start:dev) still overrides it.
//
// Returns false when there is no such file. The values are never printed.
export function loadEnvFileIfPresent(
  path: string = DEFAULT_ENV_FILE,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] === undefined && value !== undefined) {
      env[name] = value;
    }
  }
  return true;
}
