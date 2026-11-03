import type { INestApplication } from '@nestjs/common';
import {
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_LISTEN_HOST,
  DEFAULT_PORT,
  configureApp,
  describeListenHost,
  getClientOrigins,
  getListenHost,
  getPort,
  isThisComputerOnly,
} from './app.setup';

describe('getPort', () => {
  it('uses port 3001 when PORT is not set, because the client calls that port', () => {
    expect(DEFAULT_PORT).toBe(3001);
    expect(getPort({})).toBe(3001);
  });

  it('uses the port from PORT', () => {
    expect(getPort({ PORT: '4000' })).toBe(4000);
    expect(getPort({ PORT: ' 4000 ' })).toBe(4000);
    expect(getPort({ PORT: '65535' })).toBe(65535);
  });

  for (const value of [
    '',
    ' ',
    'abc',
    '0',
    '-5',
    '65536',
    '70000',
    '30.5',
    '3001abc',
    '0x10',
    '1e3',
  ]) {
    it(`falls back to 3001 when PORT is "${value}"`, () => {
      expect(getPort({ PORT: value })).toBe(3001);
    });
  }
});

describe('getClientOrigins', () => {
  it('allows only the local client page when CLIENT_ORIGIN is not set', () => {
    expect(DEFAULT_CLIENT_ORIGIN).toBe('http://localhost:3000');
    expect(getClientOrigins({})).toEqual(['http://localhost:3000']);
    expect(getClientOrigins({ CLIENT_ORIGIN: '' })).toEqual([
      'http://localhost:3000',
    ]);
    expect(getClientOrigins({ CLIENT_ORIGIN: ' , ,' })).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('uses the address from CLIENT_ORIGIN', () => {
    expect(
      getClientOrigins({ CLIENT_ORIGIN: 'https://app.example.com' }),
    ).toEqual(['https://app.example.com']);
  });

  it('removes a slash at the end, because browsers send the address without it', () => {
    expect(
      getClientOrigins({ CLIENT_ORIGIN: 'https://app.example.com/' }),
    ).toEqual(['https://app.example.com']);
  });

  it('accepts several addresses separated by commas', () => {
    expect(
      getClientOrigins({
        CLIENT_ORIGIN: 'http://localhost:3000, http://127.0.0.1:3000/,',
      }),
    ).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
  });

  it('does not turn a star into "allow everyone"', () => {
    expect(getClientOrigins({ CLIENT_ORIGIN: '*' })).toEqual(['*']);
  });
});

describe('getListenHost', () => {
  it('listens on 127.0.0.1, which only this computer can reach, when LISTEN_HOST is not set', () => {
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1');
    expect(getListenHost({})).toBe('127.0.0.1');
    expect(getListenHost({ LISTEN_HOST: '' })).toBe('127.0.0.1');
    expect(getListenHost({ LISTEN_HOST: '   ' })).toBe('127.0.0.1');
  });

  for (const value of [
    '0.0.0.0',
    '::',
    '::1',
    '127.0.0.1',
    '192.168.1.20',
    'localhost',
    'my-server',
    'my-server.example.com',
    'A1.b-2.example',
  ]) {
    it(`uses ${value}`, () => {
      expect(getListenHost({ LISTEN_HOST: value })).toBe(value);
    });
  }

  it('removes the spaces around the value', () => {
    expect(getListenHost({ LISTEN_HOST: ' 0.0.0.0 ' })).toBe('0.0.0.0');
  });

  const tooLong = Array.from({ length: 10 }, () => 'a'.repeat(30)).join('.');
  for (const value of [
    'abc def',
    '999.1.1.1',
    '1.2.3',
    '0.0.0.',
    '127.0.0.1:3001',
    'http://127.0.0.1',
    '*',
    '-bad.example',
    'bad-.example',
    'a..b',
    'a.b.',
    '/tmp/server.sock',
    'host_name',
    `h${String.fromCharCode(0xe9)}llo`,
    'x'.repeat(64),
    tooLong,
  ]) {
    it(`falls back to 127.0.0.1 when LISTEN_HOST is ${JSON.stringify(value.slice(0, 20))}`, () => {
      expect(getListenHost({ LISTEN_HOST: value })).toBe('127.0.0.1');
    });
  }
});

describe('isThisComputerOnly', () => {
  it('is true for the addresses of this computer', () => {
    for (const host of [
      'localhost',
      'LocalHost',
      '::1',
      '127.0.0.1',
      '127.255.255.254',
    ]) {
      expect(isThisComputerOnly(host)).toBe(true);
    }
  });

  it('is false for any other address, also one that only starts like 127', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.20',
      '10.0.0.1',
      '127.example.com',
      '1127.0.0.1',
      '12.7.0.1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isThisComputerOnly(host)).toBe(false);
    }
  });
});

describe('describeListenHost', () => {
  it('says, as a plain message, that only this computer can reach the server by default', () => {
    const result = describeListenHost({});
    expect(result.isWarning).toBe(false);
    expect(result.text).toContain('Only this computer can reach the server');
    expect(result.text).toContain('127.0.0.1');
  });

  for (const value of ['127.0.0.1', '127.0.0.5', '::1', 'localhost']) {
    it(`says, as a plain message, that only this computer can reach ${value}`, () => {
      const result = describeListenHost({ LISTEN_HOST: value });
      expect(result.isWarning).toBe(false);
      expect(result.text).toContain('Only this computer can reach the server');
      expect(result.text).toContain(value);
    });
  }

  for (const value of [
    '0.0.0.0',
    '::',
    '192.168.1.20',
    'my-server.example.com',
  ]) {
    it(`warns that other computers can reach ${value}, and that there is no login`, () => {
      const result = describeListenHost({ LISTEN_HOST: value });
      expect(result.isWarning).toBe(true);
      expect(result.text).toContain('Other computers can reach the server');
      expect(result.text).toContain(value);
      expect(result.text).toContain('no login');
    });
  }

  it('warns about a value that is not an address, says what is used instead, and does not repeat the value', () => {
    const result = describeListenHost({ LISTEN_HOST: 'not an address <b>' });
    expect(result.isWarning).toBe(true);
    expect(result.text).toContain('is not an IP address or a host name');
    expect(result.text).toContain('127.0.0.1');
    expect(result.text).toContain('Only this computer');
    expect(result.text).not.toContain('<b>');
  });
});

describe('configureApp', () => {
  function run(env: NodeJS.ProcessEnv): unknown[] {
    const calls: unknown[] = [];
    const app = {
      enableCors: (options: unknown) => {
        calls.push(options);
      },
    } as unknown as INestApplication;
    configureApp(app, env);
    return calls;
  }

  it('allows the client page, and only that page, to call the server', () => {
    expect(run({})).toEqual([{ origin: ['http://localhost:3000'] }]);
  });

  it('uses CLIENT_ORIGIN', () => {
    expect(run({ CLIENT_ORIGIN: 'https://app.example.com' })).toEqual([
      { origin: ['https://app.example.com'] },
    ]);
  });
});
