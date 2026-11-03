// Settings of the AI service that will analyze the documents. It can be any
// service with an OpenAI-compatible chat API (a free hosted one, or one on
// your own computer). The server reads and checks the settings here.

export const DEFAULT_AI_TIMEOUT_SECONDS = 120;
export const DEFAULT_AI_MAX_INPUT_CHARS = 30000;

export interface AiSettings {
  // The address of the service without a slash at the end, for example
  // https://example.com/v1
  baseUrl: string;
  model: string;
  // null when no key is set (a service on your own computer needs none).
  apiKey: string | null;
  // How long to wait for the answer of the service, in milliseconds.
  timeoutMs: number;
  // The longest text sent to the service, in characters. A longer document is
  // cut, because a small model can only read so much.
  maxInputChars: number;
}

export interface AiSettingsResult {
  // null when nothing is set up, or when something is wrong (see problems).
  settings: AiSettings | null;
  // Messages for the person who set the values. They never contain the key.
  problems: string[];
}

// Addresses that stay on the computer, so http is fine there.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

// A whole number from min to max. Anything else gives the default.
function wholeNumber(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const text = clean(value);
  if (/^\d+$/.test(text) === false) {
    return fallback;
  }
  const number = Number(text);
  return number >= min && number <= max ? number : fallback;
}

function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function readAiSettings(
  env: NodeJS.ProcessEnv = process.env,
): AiSettingsResult {
  const baseUrl = clean(env.AI_BASE_URL);
  const model = clean(env.AI_MODEL);
  const apiKey = clean(env.AI_API_KEY);

  if (baseUrl === '' && model === '' && apiKey === '') {
    return { settings: null, problems: [] };
  }

  const problems: string[] = [];
  if (baseUrl === '') {
    problems.push('AI_BASE_URL is missing.');
  }
  if (model === '') {
    problems.push('AI_MODEL is missing.');
  }

  const url = baseUrl === '' ? null : parseHttpUrl(baseUrl);
  if (baseUrl !== '' && url === null) {
    problems.push(
      'AI_BASE_URL must be a full address that starts with http:// or https://, for example https://example.com/v1.',
    );
  }
  if (url !== null) {
    if (url.username !== '' || url.password !== '') {
      problems.push(
        'AI_BASE_URL must not contain a user name or a password. Put the key in AI_API_KEY.',
      );
    }
    if (url.search !== '' || url.hash !== '') {
      problems.push('AI_BASE_URL must not contain a "?" or a "#" part.');
    }
    if (
      apiKey !== '' &&
      url.protocol === 'http:' &&
      LOCAL_HOSTS.includes(url.hostname) === false
    ) {
      problems.push(
        'AI_BASE_URL starts with http:// and AI_API_KEY is set, so the key would travel without encryption. Use https://.',
      );
    }
  }

  if (problems.length > 0 || url === null) {
    return { settings: null, problems };
  }

  const seconds = wholeNumber(
    env.AI_TIMEOUT_SECONDS,
    5,
    600,
    DEFAULT_AI_TIMEOUT_SECONDS,
  );

  return {
    settings: {
      baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
      model,
      apiKey: apiKey === '' ? null : apiKey,
      timeoutMs: seconds * 1000,
      maxInputChars: wholeNumber(
        env.AI_MAX_INPUT_CHARS,
        1000,
        500000,
        DEFAULT_AI_MAX_INPUT_CHARS,
      ),
    },
    problems: [],
  };
}

// One line for the log when the server starts. It shows the model, the host
// and the limits, and never the key.
export function describeAiSettings(result: AiSettingsResult): string {
  if (result.problems.length > 0) {
    return `AI service is not used. ${result.problems.join(' ')}`;
  }
  if (result.settings === null) {
    return 'AI service: not set up. Uploads are checked, but documents are not analyzed. See "Setting up the AI service" in the README.';
  }
  const { baseUrl, model, apiKey, timeoutMs, maxInputChars } = result.settings;
  const key = apiKey === null ? 'no key' : 'key set';
  return `AI service: model "${model}" at ${new URL(baseUrl).host} (${key}; at most ${maxInputChars} characters; ${timeoutMs / 1000} s)`;
}
