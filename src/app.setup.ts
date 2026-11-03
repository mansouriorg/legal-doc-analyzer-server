import type { INestApplication } from '@nestjs/common';
import { isIP } from 'node:net';

// The client (the Next.js site) calls the server on this port. See services/api.ts in the client.
export const DEFAULT_PORT = 3001;
// Where the client runs while you develop.
export const DEFAULT_CLIENT_ORIGIN = 'http://localhost:3000';

// The port from the PORT variable when it is a whole number from 1 to 65535, otherwise 3001.
export function getPort(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.PORT ?? '').trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  const isValid = Number.isInteger(port) && port > 0 && port < 65536;
  return isValid ? port : DEFAULT_PORT;
}

// The server listens on this address unless LISTEN_HOST says otherwise. Only
// the computer that runs the server can reach 127.0.0.1.
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

const HOST_NAME =
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// An IP address (version 4 or 6) or a host name. A value such as 999.1.1.1
// looks like a host name to the pattern, but it is a mistyped address, so it is
// refused.
function isUsableHost(text: string): boolean {
  if (isIP(text) !== 0) {
    return true;
  }
  if (/^[0-9.]+$/.test(text)) {
    return false;
  }
  return text.length <= 253 && HOST_NAME.test(text);
}

// The address to listen on, from the LISTEN_HOST variable. Without it, or when
// it is not an IP address or a host name, the server listens on 127.0.0.1.
// 0.0.0.0 (or ::) lets other computers reach the server.
export function getListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const text = (env.LISTEN_HOST ?? '').trim();
  return text !== '' && isUsableHost(text) ? text : DEFAULT_LISTEN_HOST;
}

// True when only the computer that runs the server can reach this address.
export function isThisComputerOnly(host: string): boolean {
  return (
    host.toLowerCase() === 'localhost' ||
    host === '::1' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}

export interface ListenDescription {
  text: string;
  isWarning: boolean;
}

// What the log says about the address, and whether it is a warning.
export function describeListenHost(
  env: NodeJS.ProcessEnv = process.env,
): ListenDescription {
  const given = (env.LISTEN_HOST ?? '').trim();
  const host = getListenHost(env);
  if (given !== '' && given !== host) {
    return {
      text: `LISTEN_HOST is not an IP address or a host name, so ${host} is used. Only this computer can reach the server.`,
      isWarning: true,
    };
  }
  if (isThisComputerOnly(host)) {
    return {
      text: `Only this computer can reach the server (address ${host}).`,
      isWarning: false,
    };
  }
  return {
    text: `Other computers can reach the server (address ${host}). It has no login: anyone who can reach it can send documents to the AI service and read the analyses it keeps.`,
    isWarning: true,
  };
}

// The client pages that may call the server, from the CLIENT_ORIGIN variable.
// Several addresses are separated by commas. A slash at the end is removed,
// because a browser sends the address without it. Default: http://localhost:3000
export function getClientOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const origins = (env.CLIENT_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin !== '');
  return origins.length > 0 ? origins : [DEFAULT_CLIENT_ORIGIN];
}

// Settings shared by the real server (main.ts) and the end-to-end tests.
export function configureApp(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // A browser only lets a page call this server when the server allows that page.
  app.enableCors({ origin: getClientOrigins(env) });
}
