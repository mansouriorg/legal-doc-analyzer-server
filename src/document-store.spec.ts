import { existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { makeTempDir, removeTempDir } from '../test/helpers/temp-dir';
import type { AnalysisResult, RiskLevel } from './ai-analyzer';
import {
  DAMAGED_MESSAGE,
  DEFAULT_DATA_DIR,
  FileDocumentStore,
  MAX_LISTED,
  NOT_SAVED_MESSAGE,
  StoreError,
  getDataDir,
  isSavedAnalysis,
  isValidId,
} from './document-store';

const ID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTHER_ID = '123e4567-e89b-42d3-a456-426614174000';

// Six clauses: 3 high, 1 medium and 2 low, so that the three counts differ.
const RISKS: RiskLevel[] = ['High', 'Medium', 'Low', 'High', 'Low', 'High'];

function analysisNamed(documentName: string): AnalysisResult {
  return {
    documentName,
    executiveSummary: 'A short contract about term and liability.',
    clauses: RISKS.map((riskLevel, index) => ({
      id: `clause-${index + 1}`,
      title: `Clause ${index + 1}`,
      originalText: `the words of clause ${index + 1}`,
      riskLevel,
      explanation: `Why clause ${index + 1} matters.`,
    })),
    notes: ['Only the beginning of the document was read.'],
  };
}

// An error made by Node itself (the file system, for example) is not an
// instance of the Error of the test, because Jest runs each test file in its own
// JavaScript world. So toBeInstanceOf(Error) does not recognize such an error.
// isNativeError does, wherever the error was made.
function isError(value: unknown): boolean {
  return types.isNativeError(value);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but nothing was thrown');
}

describe('document store', () => {
  let root = '';
  let dir = '';
  let store: FileDocumentStore;

  beforeEach(async () => {
    root = await makeTempDir();
    // The folder of the store does not exist yet, as on a new installation.
    dir = join(root, 'data');
    store = new FileDocumentStore(dir);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  describe('save', () => {
    it('returns the analysis with an id and the time it was saved', async () => {
      const now = new Date(Date.UTC(2026, 9, 25, 16, 30, 0));
      const saved = await store.save(
        analysisNamed('Employment Contract.DOCX'),
        now,
      );
      expect(saved.id).toMatch(ID_FORMAT);
      expect(saved.savedAt).toBe('2026-10-25T16:30:00.000Z');
      expect(saved.documentName).toBe('Employment Contract.DOCX');
      expect(saved.executiveSummary).toBe(
        'A short contract about term and liability.',
      );
      expect(saved.clauses).toHaveLength(6);
      expect(saved.notes).toEqual([
        'Only the beginning of the document was read.',
      ]);
    });

    it('writes one readable JSON file, named after the id, and creates the folder', async () => {
      expect(existsSync(dir)).toBe(false);
      const saved = await store.save(analysisNamed('contract.docx'));
      const names = await readdir(dir);
      expect(names).toEqual([`${saved.id}.json`]);
      const text = await readFile(join(dir, `${saved.id}.json`), 'utf8');
      expect(JSON.parse(text)).toEqual(saved);
      // Written for people to read: one field to a line, and a line at the end.
      expect(text.startsWith(`{\n  "id": "${saved.id}",\n`)).toBe(true);
      expect(text.endsWith('}\n')).toBe(true);
    });

    it('creates a folder that is several levels deep', async () => {
      const deep = new FileDocumentStore(join(root, 'a', 'b', 'c'));
      const saved = await deep.save(analysisNamed('contract.docx'));
      expect(existsSync(join(root, 'a', 'b', 'c', `${saved.id}.json`))).toBe(
        true,
      );
    });

    it('gives each analysis its own id and file, also for the same document', async () => {
      const first = await store.save(analysisNamed('contract.docx'));
      const second = await store.save(analysisNamed('contract.docx'));
      expect(first.id === second.id).toBe(false);
      expect(await readdir(dir)).toHaveLength(2);
    });

    it('lets only the owner read the file', async () => {
      if (process.platform === 'win32') {
        return;
      }
      const saved = await store.save(analysisNamed('contract.docx'));
      const file = await stat(join(dir, `${saved.id}.json`));
      expect(file.mode & 0o777).toBe(0o600);
    });

    it('keeps accents and Arabic letters as they are', async () => {
      const name = `soci${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}-${String.fromCharCode(0x639, 0x642, 0x62f)}.docx`;
      const saved = await store.save(analysisNamed(name));
      const again = await store.get(saved.id);
      expect(again?.documentName).toBe(name);
    });

    it('does not save an analysis that has the wrong form, and writes nothing', async () => {
      const wrong = {
        ...analysisNamed('contract.docx'),
        clauses: 'none',
      } as unknown as AnalysisResult;
      const error = await failure(store.save(wrong));
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).message).toBe(NOT_SAVED_MESSAGE);
      expect(existsSync(dir)).toBe(false);
    });

    it('does not save a clause with an unknown risk level', async () => {
      const analysis = analysisNamed('contract.docx');
      const wrong = {
        ...analysis,
        clauses: [{ ...analysis.clauses[0], riskLevel: 'Severe' }],
      } as unknown as AnalysisResult;
      const error = await failure(store.save(wrong));
      expect(error).toBeInstanceOf(StoreError);
    });

    it('lets only the owner enter the folder it makes', async () => {
      if (process.platform === 'win32') {
        return;
      }
      await store.save(analysisNamed('contract.docx'));
      const folder = await stat(dir);
      expect(folder.mode & 0o777).toBe(0o700);
    });

    it('does not save when the id it made is not a safe id, and writes nothing', async () => {
      const unsafe = new FileDocumentStore(dir, () => '../evil');
      const error = await failure(unsafe.save(analysisNamed('contract.docx')));
      expect(error).toBeInstanceOf(StoreError);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(root, 'evil.json'))).toBe(false);
    });

    it('removes its temporary file when it cannot finish', async () => {
      const fixed = new FileDocumentStore(dir, () => OTHER_ID);
      // A folder with a file in it stands where the file should go, so the last step fails.
      await mkdir(join(dir, `${OTHER_ID}.json`), { recursive: true });
      await writeFile(join(dir, `${OTHER_ID}.json`, 'inside.txt'), 'x');
      const error = await failure(fixed.save(analysisNamed('contract.docx')));
      expect(isError(error)).toBe(true);
      expect(await readdir(dir)).toEqual([`${OTHER_ID}.json`]);
    });

    it('fails, and leaves nothing behind, when the folder cannot be made', async () => {
      // A file is in the way of the folder.
      await writeFile(join(root, 'blocked'), 'this is a file');
      const blocked = new FileDocumentStore(join(root, 'blocked'));
      const error = await failure(blocked.save(analysisNamed('contract.docx')));
      expect(isError(error)).toBe(true);
      expect(error instanceof StoreError).toBe(false);
      expect(await readFile(join(root, 'blocked'), 'utf8')).toBe(
        'this is a file',
      );
    });
  });

  describe('get', () => {
    it('returns what was saved', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(await store.get(saved.id)).toEqual(saved);
    });

    it('returns null for an id that is not saved', async () => {
      await store.save(analysisNamed('contract.docx'));
      expect(await store.get(OTHER_ID)).toBeNull();
    });

    it('returns null when the folder does not exist yet', async () => {
      expect(await store.get(OTHER_ID)).toBeNull();
      expect(existsSync(dir)).toBe(false);
    });

    const notIds = [
      '',
      ' ',
      'abc',
      'contract',
      '../outside',
      '..%2Foutside',
      '..\\outside',
      '/etc/passwd',
      `${OTHER_ID}.json`,
      `${OTHER_ID}/`,
      `${OTHER_ID} `,
      OTHER_ID.toUpperCase(),
      OTHER_ID.replace('-', ''),
      `${OTHER_ID}\n`,
      'x'.repeat(5000),
    ];
    for (const id of notIds) {
      it(`returns null for the id ${JSON.stringify(id.slice(0, 20))}`, async () => {
        // A file that such an id would reach, if it were used in a path.
        await mkdir(dir, { recursive: true });
        await writeFile(join(root, 'outside.json'), '{"secret": true}');
        expect(await store.get(id)).toBeNull();
      });
    }

    it('throws a StoreError for a file that is not JSON, without its content', async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${OTHER_ID}.json`),
        '{"documentName": "secret-divorce.docx", "clauses": [',
      );
      const error = await failure(store.get(OTHER_ID));
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).message).toBe(DAMAGED_MESSAGE);
      expect((error as StoreError).message).not.toContain('secret-divorce');
      expect(DAMAGED_MESSAGE).toContain('cannot be read');
    });

    it('throws a StoreError for JSON that is not an analysis', async () => {
      await mkdir(dir, { recursive: true });
      for (const content of ['[]', 'null', '"text"', '42', '{}']) {
        await writeFile(join(dir, `${OTHER_ID}.json`), content);
        const error = await failure(store.get(OTHER_ID));
        expect(error).toBeInstanceOf(StoreError);
      }
    });

    it('throws a StoreError when a field of the file was changed to the wrong kind', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      const file = join(dir, `${saved.id}.json`);
      const changes: Array<Record<string, unknown>> = [
        { documentName: 5 },
        { executiveSummary: null },
        { clauses: {} },
        { clauses: [5] },
        { clauses: [{ id: 'x' }] },
        { notes: 'one note' },
        { notes: [1] },
        { savedAt: 'yesterday' },
        { savedAt: 5 },
        { id: 'not-an-id' },
      ];
      for (const change of changes) {
        await writeFile(file, JSON.stringify({ ...saved, ...change }));
        const error = await failure(store.get(saved.id));
        expect(error).toBeInstanceOf(StoreError);
      }
    });

    it('throws a StoreError when the id inside the file is not the id in its name', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      await writeFile(join(dir, `${OTHER_ID}.json`), JSON.stringify(saved));
      const error = await failure(store.get(OTHER_ID));
      expect(error).toBeInstanceOf(StoreError);
    });

    it('does not hide an error that is not about the content of the file', async () => {
      // A folder with the name of the file cannot be read as a file.
      await mkdir(join(dir, `${OTHER_ID}.json`), { recursive: true });
      const error = await failure(store.get(OTHER_ID));
      expect(isError(error)).toBe(true);
      expect(error instanceof StoreError).toBe(false);
    });
  });

  describe('list', () => {
    it('is empty when the folder does not exist, and does not make it', async () => {
      expect(await store.list()).toEqual({
        documents: [],
        total: 0,
        unreadable: 0,
      });
      expect(existsSync(dir)).toBe(false);
    });

    it('is empty when the folder is empty', async () => {
      await mkdir(dir, { recursive: true });
      expect(await store.list()).toEqual({
        documents: [],
        total: 0,
        unreadable: 0,
      });
    });

    it('lists the newest first, with the numbers for a history page', async () => {
      const older = await store.save(
        analysisNamed('older.docx'),
        new Date(Date.UTC(2026, 0, 1)),
      );
      const newer = await store.save(
        analysisNamed('newer.pdf'),
        new Date(Date.UTC(2026, 5, 1)),
      );
      const middle = await store.save(
        analysisNamed('middle.pdf'),
        new Date(Date.UTC(2026, 3, 1)),
      );
      const list = await store.list();
      expect(list.total).toBe(3);
      expect(list.unreadable).toBe(0);
      expect(list.documents.map((item) => item.id)).toEqual([
        newer.id,
        middle.id,
        older.id,
      ]);
      expect(list.documents[0]).toEqual({
        id: newer.id,
        documentName: 'newer.pdf',
        savedAt: '2026-06-01T00:00:00.000Z',
        clauseCount: 6,
        highRisks: 3,
        mediumRisks: 1,
        lowRisks: 2,
      });
    });

    it('puts analyses saved at the same time in a fixed order', async () => {
      const when = new Date(Date.UTC(2026, 0, 1));
      const a = await store.save(analysisNamed('a.docx'), when);
      const b = await store.save(analysisNamed('b.docx'), when);
      const first = (await store.list()).documents.map((item) => item.id);
      const second = (await store.list()).documents.map((item) => item.id);
      expect(first).toEqual(second);
      expect(first).toEqual([a.id, b.id].sort().reverse());
    });

    it('does not put the clauses or the summary in the list', async () => {
      await store.save(analysisNamed('contract.docx'));
      const item = (await store.list()).documents[0];
      expect(Object.keys(item).sort()).toEqual([
        'clauseCount',
        'documentName',
        'highRisks',
        'id',
        'lowRisks',
        'mediumRisks',
        'savedAt',
      ]);
    });

    it('lists at most MAX_LISTED analyses, the newest, and says how many there are', async () => {
      expect(MAX_LISTED).toBe(100);
      const total = MAX_LISTED + 5;
      let newest = '';
      for (let index = 0; index < total; index += 1) {
        const saved = await store.save(
          analysisNamed(`contract-${index}.docx`),
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        );
        newest = saved.id;
      }
      const list = await store.list();
      expect(list.total).toBe(total);
      expect(list.documents).toHaveLength(MAX_LISTED);
      expect(list.documents[0].id).toBe(newest);
      expect(list.documents[0].documentName).toBe(`contract-${total - 1}.docx`);
      expect(list.documents[MAX_LISTED - 1].documentName).toBe(
        'contract-5.docx',
      );
    });

    it('counts a file that cannot be read, and still lists the others', async () => {
      const good = await store.save(analysisNamed('good.docx'));
      await writeFile(join(dir, `${OTHER_ID}.json`), 'not json at all');
      const list = await store.list();
      expect(list.unreadable).toBe(1);
      expect(list.total).toBe(1);
      expect(list.documents.map((item) => item.id)).toEqual([good.id]);
    });

    it('counts a folder that has the name of a file as unreadable', async () => {
      await mkdir(join(dir, `${OTHER_ID}.json`), { recursive: true });
      const list = await store.list();
      expect(list.unreadable).toBe(1);
      expect(list.documents).toHaveLength(0);
    });

    it('ignores files that are not saved analyses', async () => {
      const good = await store.save(analysisNamed('good.docx'));
      await writeFile(join(dir, 'notes.txt'), 'my notes');
      await writeFile(join(dir, 'other.json'), '{}');
      await writeFile(join(dir, `${OTHER_ID}.tmp`), 'half written');
      await writeFile(join(dir, `${OTHER_ID}.json.bak`), '{}');
      // A copy of a real file, with something added to its name.
      await writeFile(join(dir, `${good.id}.json.bak`), '{}');
      await writeFile(join(dir, `copy-of-${good.id}.json`), '{}');
      await writeFile(join(dir, `${OTHER_ID.toUpperCase()}.json`), '{}');
      const list = await store.list();
      expect(list.unreadable).toBe(0);
      expect(list.documents.map((item) => item.id)).toEqual([good.id]);
    });
  });

  describe('delete', () => {
    it('removes the file of the analysis and returns true', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(await store.delete(saved.id)).toBe(true);
      expect(existsSync(join(dir, `${saved.id}.json`))).toBe(false);
      expect(await store.get(saved.id)).toBeNull();
      expect((await store.list()).total).toBe(0);
    });

    it('returns false when the analysis is already gone', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(await store.delete(saved.id)).toBe(true);
      expect(await store.delete(saved.id)).toBe(false);
    });

    it('returns false for an id that is not saved, and changes nothing', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(await store.delete(OTHER_ID)).toBe(false);
      expect(await readdir(dir)).toEqual([`${saved.id}.json`]);
    });

    it('removes only the analysis with this id', async () => {
      const first = await store.save(
        analysisNamed('first.docx'),
        new Date(Date.UTC(2026, 0, 1)),
      );
      const second = await store.save(
        analysisNamed('second.docx'),
        new Date(Date.UTC(2026, 1, 1)),
      );
      const third = await store.save(
        analysisNamed('third.docx'),
        new Date(Date.UTC(2026, 2, 1)),
      );
      const before = await readFile(join(dir, `${first.id}.json`), 'utf8');

      expect(await store.delete(second.id)).toBe(true);

      const list = await store.list();
      expect(list.documents.map((item) => item.id)).toEqual([
        third.id,
        first.id,
      ]);
      expect(await readFile(join(dir, `${first.id}.json`), 'utf8')).toBe(
        before,
      );
    });

    it('returns false for anything that is not an id made by the store, and removes nothing', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      // Files that a loose check of the id would reach.
      await writeFile(join(dir, 'other.json'), '{}');
      await writeFile(join(dir, `copy-of-${saved.id}.json`), '{}');
      await writeFile(join(dir, `${OTHER_ID.toUpperCase()}.json`), '{}');
      await mkdir(join(dir, 'archive'));
      await writeFile(join(dir, 'archive', `${saved.id}.json`), '{}');
      await writeFile(join(root, 'outside.json'), '{}');
      const wrong = [
        '',
        '.',
        '..',
        '../outside',
        '..\\outside',
        `../data/${saved.id}`,
        join(dir, saved.id),
        'other',
        `copy-of-${saved.id}`,
        `archive/${saved.id}`,
        `${saved.id}.json`,
        `${saved.id} `,
        `${saved.id}\n`,
        OTHER_ID.toUpperCase(),
      ];
      for (const id of wrong) {
        expect(await store.delete(id)).toBe(false);
      }
      expect((await readdir(dir)).sort()).toEqual(
        [
          'archive',
          'other.json',
          `copy-of-${saved.id}.json`,
          `${OTHER_ID.toUpperCase()}.json`,
          `${saved.id}.json`,
        ].sort(),
      );
      expect(existsSync(join(dir, 'archive', `${saved.id}.json`))).toBe(true);
      expect(existsSync(join(root, 'outside.json'))).toBe(true);
    });

    it('does not remove a file that only has a similar name', async () => {
      await mkdir(dir, { recursive: true });
      const similar = [
        'notes.txt',
        `${OTHER_ID}.tmp`,
        `${OTHER_ID}.json.bak`,
        `copy-of-${OTHER_ID}.json`,
      ];
      for (const name of similar) {
        await writeFile(join(dir, name), 'keep me');
      }
      expect(await store.delete(OTHER_ID)).toBe(false);
      expect((await readdir(dir)).sort()).toEqual([...similar].sort());
    });

    it('removes a file whose content is damaged, so that it can be cleaned up', async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${OTHER_ID}.json`), 'not json at all');
      expect((await store.list()).unreadable).toBe(1);
      expect(await store.delete(OTHER_ID)).toBe(true);
      expect(existsSync(join(dir, `${OTHER_ID}.json`))).toBe(false);
      expect((await store.list()).unreadable).toBe(0);
    });

    it('returns false when the folder does not exist, and does not make it', async () => {
      expect(await store.delete(OTHER_ID)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    });

    it('leaves the data folder in place when the last analysis is removed', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(await store.delete(saved.id)).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    });

    it('does not remove a folder that has the name of a file, and throws', async () => {
      const folder = join(dir, `${OTHER_ID}.json`);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'inside.txt'), 'keep me');
      const error = await failure(store.delete(OTHER_ID));
      expect(isError(error)).toBe(true);
      expect(error instanceof StoreError).toBe(false);
      expect(await readFile(join(folder, 'inside.txt'), 'utf8')).toBe(
        'keep me',
      );
    });

    it('removes a link, but not the file the link points to', async () => {
      await mkdir(dir, { recursive: true });
      const target = join(root, 'target.json');
      await writeFile(target, 'keep me');
      await symlink(target, join(dir, `${OTHER_ID}.json`));
      expect(await store.delete(OTHER_ID)).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('keep me');
      expect(await readdir(dir)).toEqual([]);
    });

    it('works when the same id is deleted twice at the same time', async () => {
      const saved = await store.save(analysisNamed('contract.docx'));
      // Neither request may throw. Whether the second one still finds the
      // file is up to the file system (on a Mac both can say true), so only
      // "at least one says true" and "the file is gone" are checked.
      const results = await Promise.all([
        store.delete(saved.id),
        store.delete(saved.id),
      ]);
      expect(results.some((done) => done === true)).toBe(true);
      expect(existsSync(join(dir, `${saved.id}.json`))).toBe(false);
      expect(await store.delete(saved.id)).toBe(false);
    });
  });
});

describe('isValidId', () => {
  it('accepts the id of a UUID in lower case', () => {
    expect(isValidId(OTHER_ID)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('../x')).toBe(false);
    expect(isValidId(OTHER_ID.toUpperCase())).toBe(false);
    expect(isValidId(`${OTHER_ID}x`)).toBe(false);
    expect(isValidId(`x${OTHER_ID}`)).toBe(false);
  });
});

describe('isSavedAnalysis', () => {
  const good = {
    id: OTHER_ID,
    savedAt: '2026-10-25T16:30:00.000Z',
    ...analysisNamed('contract.docx'),
  };

  it('accepts a complete analysis', () => {
    expect(isSavedAnalysis(good)).toBe(true);
  });

  it('refuses things that are not an analysis', () => {
    for (const value of [null, undefined, 5, 'text', [], [good]]) {
      expect(isSavedAnalysis(value)).toBe(false);
    }
  });

  it('refuses a clause that lacks a field or has a field of the wrong kind', () => {
    const clause = good.clauses[0];
    for (const field of Object.keys(clause)) {
      const missing: Record<string, unknown> = { ...clause };
      delete missing[field];
      expect(isSavedAnalysis({ ...good, clauses: [missing] })).toBe(false);
      const wrong = { ...clause, [field]: 5 };
      expect(isSavedAnalysis({ ...good, clauses: [wrong] })).toBe(false);
    }
  });

  it('accepts each risk level and refuses any other', () => {
    for (const level of ['Low', 'Medium', 'High']) {
      const clause = { ...good.clauses[0], riskLevel: level };
      expect(isSavedAnalysis({ ...good, clauses: [clause] })).toBe(true);
    }
    for (const level of ['low', 'HIGH', 'Severe', '', 'toString']) {
      const clause = { ...good.clauses[0], riskLevel: level };
      expect(isSavedAnalysis({ ...good, clauses: [clause] })).toBe(false);
    }
  });

  it('refuses an id or a time that is a list holding the right text', () => {
    expect(isSavedAnalysis({ ...good, id: [OTHER_ID] })).toBe(false);
    expect(isSavedAnalysis({ ...good, savedAt: [good.savedAt] })).toBe(false);
  });

  it('refuses an analysis that lacks a field', () => {
    for (const field of Object.keys(good)) {
      const copy: Record<string, unknown> = { ...good };
      delete copy[field];
      expect(isSavedAnalysis(copy)).toBe(false);
    }
  });
});

describe('getDataDir', () => {
  it('is the folder "data" where the server is started, without a setting', () => {
    expect(DEFAULT_DATA_DIR).toBe('data');
    expect(getDataDir({}, join('/work', 'server'))).toBe(
      join('/work', 'server', 'data'),
    );
  });

  it('uses DATA_DIR, from the folder where the server is started when it is relative', () => {
    expect(getDataDir({ DATA_DIR: 'saved' }, join('/work', 'server'))).toBe(
      join('/work', 'server', 'saved'),
    );
    expect(getDataDir({ DATA_DIR: ' saved ' }, join('/work', 'server'))).toBe(
      join('/work', 'server', 'saved'),
    );
  });

  it('uses a full path as it is', () => {
    expect(getDataDir({ DATA_DIR: join('/var', 'analyses') }, '/work')).toBe(
      join('/var', 'analyses'),
    );
  });

  it('uses the default when DATA_DIR is empty', () => {
    expect(getDataDir({ DATA_DIR: '' }, '/work')).toBe(join('/work', 'data'));
    expect(getDataDir({ DATA_DIR: '   ' }, '/work')).toBe(
      join('/work', 'data'),
    );
  });
});

describe('removeTempDir', () => {
  let root = '';
  let sibling = '';

  beforeEach(async () => {
    root = await makeTempDir();
    // A folder next to the test folder, which is not a test folder. If the
    // guard were broken, this is the only thing the tests below could remove.
    sibling = join(dirname(root), 'not-a-test-folder');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'keep.txt'), 'keep');
  });

  afterEach(async () => {
    await rm(sibling, { recursive: true, force: true });
    await removeTempDir(root);
  });

  it('refuses a folder that was not made by makeTempDir', async () => {
    const error = await failure(removeTempDir(sibling));
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a path that leads out of a test folder with ..', async () => {
    const error = await failure(
      removeTempDir(join(root, '..', 'not-a-test-folder')),
    );
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('removes a test folder with its files', async () => {
    const other = await makeTempDir();
    await writeFile(join(other, 'file.txt'), 'x');
    await removeTempDir(other);
    expect(existsSync(other)).toBe(false);
  });
});
