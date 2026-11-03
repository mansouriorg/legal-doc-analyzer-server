import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AnalysisResult, RiskLevel } from './ai-analyzer';

// Saves the analyses on the disk of the computer that runs the server, one
// JSON file for each analysis. There is no database, so nothing has to be
// installed. The files are plain text: you can open one, and you can delete one
// to remove that analysis. POST /analyze writes them, GET /documents reads them
// and DELETE /documents/:id removes one (see analyze.controller.ts and
// documents.controller.ts).

// The name under which Nest hands the store to the controllers. The tests give
// their own.
export const DOCUMENT_STORE = 'DOCUMENT_STORE';

// The folder is "data" inside the folder where the server is started (the
// server folder), unless the DATA_DIR setting says otherwise.
export const DEFAULT_DATA_DIR = 'data';

// The list of analyses has at most this many entries, the newest first.
export const MAX_LISTED = 100;

// An analysis as it is saved in its file: the result of the analysis, with an
// id and the time it was saved.
export interface SavedAnalysis extends AnalysisResult {
  // Made by the server when the analysis is saved.
  id: string;
  // When it was saved: a date and time in UTC, such as 2026-10-25T16:30:00.000Z
  savedAt: string;
}

// One line of the list, with the numbers a history page needs.
export interface DocumentSummary {
  id: string;
  documentName: string;
  savedAt: string;
  clauseCount: number;
  highRisks: number;
  mediumRisks: number;
  lowRisks: number;
}

export interface DocumentList {
  // The newest first, at most MAX_LISTED.
  documents: DocumentSummary[];
  // How many saved analyses can be read, also those that are not in the list.
  total: number;
  // How many files in the folder look like saved analyses but cannot be read.
  unreadable: number;
}

export interface DocumentStore {
  save(analysis: AnalysisResult): Promise<SavedAnalysis>;
  // null when there is no analysis with this id.
  get(id: string): Promise<SavedAnalysis | null>;
  list(): Promise<DocumentList>;
  // Removes the file of one analysis for good. true when it was removed, false
  // when there is no analysis with this id.
  delete(id: string): Promise<boolean>;
}

export const DAMAGED_MESSAGE =
  'The saved file of this analysis cannot be read. It may have been changed or damaged.';
export const NOT_SAVED_MESSAGE =
  'The analysis has an unexpected form, so it was not saved.';

// An error whose message is fixed. It never contains the text of a document,
// the name of a document or the content of a file.
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

// The id is 36 characters of a random UUID, in lower case. Only such an id is
// ever used in a file name, so an id like "../../package" cannot reach any
// other file.
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// The folder for the saved analyses from the DATA_DIR setting. A relative path
// starts from the folder where the server is started. Without the setting, the
// folder is "data" there.
export function getDataDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const value = (env.DATA_DIR ?? '').trim();
  return value === '' ? join(cwd, DEFAULT_DATA_DIR) : resolve(cwd, value);
}

// A Record, so that the compiler complains when a new level is added to the
// analysis and not to this list.
const RISK_LEVELS: Record<RiskLevel, true> = {
  Low: true,
  Medium: true,
  High: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(value) === false
  );
}

function isClause(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.originalText === 'string' &&
    typeof value.explanation === 'string' &&
    typeof value.riskLevel === 'string' &&
    Object.hasOwn(RISK_LEVELS, value.riskLevel)
  );
}

// Checks the whole form of a saved analysis. It is used before a file is
// written, so that nothing is saved that cannot be read back, and after a file
// is read, because a person can change the file.
export function isSavedAnalysis(value: unknown): value is SavedAnalysis {
  if (isRecord(value)) {
    const clauses: unknown = value.clauses;
    const notes: unknown = value.notes;
    return (
      typeof value.id === 'string' &&
      isValidId(value.id) &&
      typeof value.savedAt === 'string' &&
      Number.isNaN(Date.parse(value.savedAt)) === false &&
      typeof value.documentName === 'string' &&
      typeof value.executiveSummary === 'string' &&
      Array.isArray(clauses) &&
      clauses.every(isClause) &&
      Array.isArray(notes) &&
      notes.every((note) => typeof note === 'string')
    );
  }
  return false;
}

function summarize(saved: SavedAnalysis): DocumentSummary {
  const count = (level: RiskLevel): number =>
    saved.clauses.filter((clause) => clause.riskLevel === level).length;
  return {
    id: saved.id,
    documentName: saved.documentName,
    savedAt: saved.savedAt,
    clauseCount: saved.clauses.length,
    highRisks: count('High'),
    mediumRisks: count('Medium'),
    lowRisks: count('Low'),
  };
}

// The newest first. Analyses saved at the same time are put in the order of
// their ids, so that the order is always the same.
function newestFirst(a: SavedAnalysis, b: SavedAnalysis): number {
  const byTime = Date.parse(b.savedAt) - Date.parse(a.savedAt);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export class FileDocumentStore implements DocumentStore {
  constructor(
    private readonly dir: string,
    // Makes the id of a new analysis. Only the tests give another one.
    private readonly newId: () => string = randomUUID,
  ) {}

  // Writes the analysis to a new file and returns it with its id. The folder
  // is made when it does not exist. The file is written under a temporary name
  // and then renamed, so a reader never sees a half-written file. Only the
  // owner can read the file (on systems that have such rights). `now` is only
  // given by the tests.
  async save(
    analysis: AnalysisResult,
    now: Date = new Date(),
  ): Promise<SavedAnalysis> {
    const saved: SavedAnalysis = {
      id: this.newId(),
      savedAt: now.toISOString(),
      documentName: analysis.documentName,
      executiveSummary: analysis.executiveSummary,
      clauses: analysis.clauses,
      notes: analysis.notes,
    };
    if (isSavedAnalysis(saved) === false) {
      throw new StoreError(NOT_SAVED_MESSAGE);
    }

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const finalPath = join(this.dir, `${saved.id}.json`);
    const temporaryPath = join(this.dir, `${saved.id}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return saved;
  }

  // The saved analysis, or null when there is none with this id. Anything that
  // is not an id made by this store gives null, without looking at the disk.
  // A file that cannot be read as an analysis gives a StoreError.
  async get(id: string): Promise<SavedAnalysis | null> {
    if (isValidId(id) === false) {
      return null;
    }
    let text: string;
    try {
      text = await readFile(join(this.dir, `${id}.json`), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new StoreError(DAMAGED_MESSAGE);
    }
    // The id inside the file must be the id in its name.
    if (isSavedAnalysis(data) && data.id === id) {
      return data;
    }
    throw new StoreError(DAMAGED_MESSAGE);
  }

  // Reads every saved analysis and lists the newest first. A folder that does
  // not exist yet is an empty list, and listing does not create it.
  async list(): Promise<DocumentList> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { documents: [], total: 0, unreadable: 0 };
      }
      throw error;
    }

    const found: SavedAnalysis[] = [];
    let unreadable = 0;
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (match === null) {
        continue;
      }
      try {
        const saved = await this.get(match[1]);
        if (saved !== null) {
          found.push(saved);
        }
      } catch {
        unreadable += 1;
      }
    }

    found.sort(newestFirst);
    return {
      documents: found.slice(0, MAX_LISTED).map(summarize),
      total: found.length,
      unreadable,
    };
  }

  // Removes the file of one analysis, for good: it cannot be brought back.
  // true when the file was removed, false when there is none with this id.
  // Anything that is not an id made by this store gives false, without looking
  // at the disk. Only the one file of this id is removed: never a folder, never
  // a file with another name, and for a link only the link. A file that cannot
  // be read as an analysis is removed too, so that a damaged file can be
  // cleaned up. The data folder is not made and not removed.
  async delete(id: string): Promise<boolean> {
    if (isValidId(id) === false) {
      return false;
    }
    try {
      await unlink(join(this.dir, `${id}.json`));
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}
