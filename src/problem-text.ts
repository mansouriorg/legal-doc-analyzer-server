import { types } from 'node:util';
import { StoreError } from './document-store';

// What the log of the server may say about a problem with a saved file: the
// fixed message of the store, or the kind of the error and its code. Never the
// message of an error of the system, because it holds a path, and never the
// name or the text of a document.

// The code of a system error, such as EACCES (no right to write) or ENOSPC
// (the disk is full).
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,30}$/;

// A text field of a value, or null when there is none.
function readText(value: unknown, key: string): string | null {
  if (typeof value === 'object' && value !== null) {
    const field: unknown = Reflect.get(value, key);
    return typeof field === 'string' ? field : null;
  }
  return null;
}

export function describeProblem(error: unknown): string {
  if (error instanceof StoreError) {
    return error.message;
  }
  // isNativeError also knows an error made by Node itself, which is not an
  // instance of the Error of this file when Jest runs the code.
  if (types.isNativeError(error)) {
    const name = readText(error, 'name') ?? 'Error';
    const code = readText(error, 'code');
    return code !== null && ERROR_CODE.test(code) ? `${name} ${code}` : name;
  }
  return 'an error that is not an Error';
}
