import { describeAiSettings, readAiSettings } from './ai-settings';

const valid = {
  AI_BASE_URL: 'https://api.example.com/v1',
  AI_MODEL: 'small-model',
};

describe('readAiSettings', () => {
  it('is quiet when nothing is set up', () => {
    expect(readAiSettings({})).toEqual({ settings: null, problems: [] });
  });

  it('treats empty and blank values as not set', () => {
    const env = { AI_BASE_URL: '', AI_MODEL: '  ', AI_API_KEY: '' };
    expect(readAiSettings(env)).toEqual({ settings: null, problems: [] });
  });

  it('accepts an address and a model, and has no key', () => {
    expect(readAiSettings(valid)).toEqual({
      settings: {
        baseUrl: 'https://api.example.com/v1',
        model: 'small-model',
        apiKey: null,
        timeoutMs: 120000,
        maxInputChars: 30000,
      },
      problems: [],
    });
  });

  it('reads the time limit and the text limit', () => {
    const result = readAiSettings({
      ...valid,
      AI_TIMEOUT_SECONDS: ' 45 ',
      AI_MAX_INPUT_CHARS: '8000',
    });
    expect(result.settings?.timeoutMs).toBe(45000);
    expect(result.settings?.maxInputChars).toBe(8000);
  });

  it('uses the defaults for a limit that is not a whole number or out of range', () => {
    const wrong = ['abc', '', '-5', '1.5', '4', '601', '0'];
    for (const AI_TIMEOUT_SECONDS of wrong) {
      const result = readAiSettings({ ...valid, AI_TIMEOUT_SECONDS });
      expect(result.settings?.timeoutMs).toBe(120000);
    }
    for (const AI_MAX_INPUT_CHARS of ['abc', '999', '500001', '2e4']) {
      const result = readAiSettings({ ...valid, AI_MAX_INPUT_CHARS });
      expect(result.settings?.maxInputChars).toBe(30000);
    }
  });

  it('accepts the smallest and the largest limits', () => {
    const result = readAiSettings({
      ...valid,
      AI_TIMEOUT_SECONDS: '5',
      AI_MAX_INPUT_CHARS: '500000',
    });
    expect(result.settings?.timeoutMs).toBe(5000);
    expect(result.settings?.maxInputChars).toBe(500000);
    const low = readAiSettings({
      ...valid,
      AI_TIMEOUT_SECONDS: '600',
      AI_MAX_INPUT_CHARS: '1000',
    });
    expect(low.settings?.timeoutMs).toBe(600000);
    expect(low.settings?.maxInputChars).toBe(1000);
  });

  it('trims the values and keeps the key', () => {
    const result = readAiSettings({
      AI_BASE_URL: '  https://api.example.com/v1  ',
      AI_MODEL: ' small-model ',
      AI_API_KEY: '  abc-123 ',
    });
    expect(result.settings?.model).toBe('small-model');
    expect(result.settings?.apiKey).toBe('abc-123');
    expect(result.settings?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('removes slashes at the end of the address', () => {
    const one = readAiSettings({ ...valid, AI_BASE_URL: 'https://a.io/v1/' });
    const many = readAiSettings({ ...valid, AI_BASE_URL: 'https://a.io/v1//' });
    const none = readAiSettings({ ...valid, AI_BASE_URL: 'https://a.io/' });
    expect(one.settings?.baseUrl).toBe('https://a.io/v1');
    expect(many.settings?.baseUrl).toBe('https://a.io/v1');
    expect(none.settings?.baseUrl).toBe('https://a.io');
  });

  it('keeps the port and the path of the address', () => {
    const result = readAiSettings({
      AI_BASE_URL: 'http://localhost:11434/v1',
      AI_MODEL: 'local-model',
    });
    expect(result.settings?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('says what is missing when only the model is set', () => {
    const result = readAiSettings({ AI_MODEL: 'small-model' });
    expect(result.settings).toBeNull();
    expect(result.problems).toEqual(['AI_BASE_URL is missing.']);
  });

  it('says what is missing when only the address is set', () => {
    const result = readAiSettings({ AI_BASE_URL: valid.AI_BASE_URL });
    expect(result.settings).toBeNull();
    expect(result.problems).toEqual(['AI_MODEL is missing.']);
  });

  it('says both are missing when only the key is set', () => {
    const result = readAiSettings({ AI_API_KEY: 'abc-123' });
    expect(result.settings).toBeNull();
    expect(result.problems).toEqual([
      'AI_BASE_URL is missing.',
      'AI_MODEL is missing.',
    ]);
  });

  it('rejects an address that is not a full http or https address', () => {
    const wrong = [
      'api.example.com/v1',
      'localhost:11434/v1',
      'ftp://api.example.com/v1',
      'not an address',
    ];
    for (const AI_BASE_URL of wrong) {
      const result = readAiSettings({ ...valid, AI_BASE_URL });
      expect(result.settings).toBeNull();
      expect(result.problems.length).toBe(1);
      expect(result.problems[0]).toMatch(/starts with http:\/\/ or https:\/\//);
    }
  });

  it('rejects a user name or a password inside the address', () => {
    const result = readAiSettings({
      ...valid,
      AI_BASE_URL: 'https://user:secret@api.example.com/v1',
    });
    expect(result.settings).toBeNull();
    expect(result.problems[0]).toMatch(/user name or a password/);
    expect(result.problems.join(' ')).not.toContain('secret');
  });

  it('rejects an address with a query or a fragment', () => {
    for (const suffix of ['?x=1', '#top']) {
      const result = readAiSettings({
        ...valid,
        AI_BASE_URL: valid.AI_BASE_URL + suffix,
      });
      expect(result.settings).toBeNull();
      expect(result.problems[0]).toMatch(/"\?" or a "#" part/);
    }
  });

  it('refuses to send a key over plain http to another computer', () => {
    const result = readAiSettings({
      AI_BASE_URL: 'http://api.example.com/v1',
      AI_MODEL: 'small-model',
      AI_API_KEY: 'abc-123',
    });
    expect(result.settings).toBeNull();
    expect(result.problems[0]).toMatch(/without encryption/);
    expect(result.problems.join(' ')).not.toContain('abc-123');
  });

  it('allows plain http when the service is on this computer, with a key', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const result = readAiSettings({
        AI_BASE_URL: `http://${host}:11434/v1`,
        AI_MODEL: 'local-model',
        AI_API_KEY: 'abc-123',
      });
      expect(result.problems).toEqual([]);
      expect(result.settings?.apiKey).toBe('abc-123');
    }
  });

  it('allows plain http to another computer when there is no key to protect', () => {
    const result = readAiSettings({
      AI_BASE_URL: 'http://192.168.1.20:8080/v1',
      AI_MODEL: 'local-model',
    });
    expect(result.problems).toEqual([]);
    expect(result.settings?.apiKey).toBeNull();
  });

  it('reports every problem at once', () => {
    const result = readAiSettings({
      AI_BASE_URL: 'http://user:pw@api.example.com/v1?x=1',
      AI_API_KEY: 'abc-123',
    });
    expect(result.settings).toBeNull();
    expect(result.problems.length).toBe(4);
  });

  it('reads process.env when no environment is given', () => {
    const names = ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY'];
    const before = names.map((name) => process.env[name]);
    for (const name of names) {
      delete process.env[name];
    }
    expect(readAiSettings()).toEqual({ settings: null, problems: [] });
    process.env.AI_MODEL = 'only-a-model';
    expect(readAiSettings().problems).toEqual(['AI_BASE_URL is missing.']);
    names.forEach((name, index) => {
      const value = before[index];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  });
});

describe('describeAiSettings', () => {
  it('says when nothing is set up and points to the README', () => {
    const text = describeAiSettings(readAiSettings({}));
    expect(text).toMatch(/^AI service: not set up/);
    expect(text).toContain('Setting up the AI service');
  });

  it('says that the service is not used and lists the problems', () => {
    const text = describeAiSettings(readAiSettings({ AI_MODEL: 'x' }));
    expect(text).toBe('AI service is not used. AI_BASE_URL is missing.');
  });

  it('shows the model, the host and whether a key is set', () => {
    const without = describeAiSettings(readAiSettings(valid));
    expect(without).toBe(
      'AI service: model "small-model" at api.example.com (no key; at most 30000 characters; 120 s)',
    );
    const withKey = describeAiSettings(
      readAiSettings({ ...valid, AI_API_KEY: 'abc-123' }),
    );
    expect(withKey).toBe(
      'AI service: model "small-model" at api.example.com (key set; at most 30000 characters; 120 s)',
    );
  });

  it('shows the limits that are really used', () => {
    const text = describeAiSettings(
      readAiSettings({
        ...valid,
        AI_TIMEOUT_SECONDS: '45',
        AI_MAX_INPUT_CHARS: '8000',
      }),
    );
    expect(text).toContain('at most 8000 characters; 45 s)');
  });

  it('shows the port of a service on this computer', () => {
    const text = describeAiSettings(
      readAiSettings({
        AI_BASE_URL: 'http://localhost:11434/v1',
        AI_MODEL: 'local-model',
      }),
    );
    expect(text).toContain('at localhost:11434 (no key;');
  });

  it('never contains the key or the path of the address', () => {
    const text = describeAiSettings(
      readAiSettings({
        AI_BASE_URL: 'https://api.example.com/private/path/v1',
        AI_MODEL: 'small-model',
        AI_API_KEY: 'SECRET-KEY-123',
      }),
    );
    expect(text).not.toContain('SECRET-KEY-123');
    expect(text).not.toContain('private');
  });
});
