import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AnalysisResult, RiskLevel } from './../src/ai-analyzer';
import { AppModule } from './../src/app.module';
import { DEFAULT_CLIENT_ORIGIN, configureApp } from './../src/app.setup';
import {
  DAMAGED_MESSAGE,
  DOCUMENT_STORE,
  FileDocumentStore,
  type DocumentList,
  type SavedAnalysis,
} from './../src/document-store';
import { DELETE_FAILED_MESSAGE } from './../src/documents.controller';
import { makeTempDir, removeTempDir } from './helpers/temp-dir';

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

describe('GET /documents (e2e)', () => {
  let app: INestApplication<App>;
  let root = '';
  let dir = '';
  let store: FileDocumentStore;

  beforeEach(async () => {
    root = await makeTempDir();
    dir = join(root, 'data');
    store = new FileDocumentStore(dir);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DOCUMENT_STORE)
      .useValue(store)
      .compile();

    app = moduleFixture.createNestApplication();
    // The log would only repeat what the tests check.
    app.useLogger(false);
    // An empty environment, so the test does not depend on your shell settings.
    configureApp(app, {});
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await removeTempDir(root);
  });

  it('answers with an empty list when nothing is saved yet', async () => {
    const response = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);
    expect(response.body).toEqual({ documents: [], total: 0, unreadable: 0 });
  });

  it('lists the saved analyses, the newest first', async () => {
    const older = await store.save(
      analysisNamed('older.docx'),
      new Date(Date.UTC(2026, 0, 1)),
    );
    const newer = await store.save(
      analysisNamed('newer.pdf'),
      new Date(Date.UTC(2026, 5, 1)),
    );
    const response = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);

    const body = response.body as DocumentList;
    expect(body.total).toBe(2);
    expect(body.documents.map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(body.documents[0].documentName).toBe('newer.pdf');
    expect(body.documents[0].clauseCount).toBe(6);
    expect(body.documents[0].highRisks).toBe(3);
    expect(body.documents[0].mediumRisks).toBe(1);
    expect(body.documents[0].lowRisks).toBe(2);
  });

  it('returns one saved analysis, with its id and the time it was saved', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    const response = await request(app.getHttpServer())
      .get(`/documents/${saved.id}`)
      .expect(200);

    const body = response.body as SavedAnalysis;
    expect(body).toEqual(saved);
    expect(body.documentName).toBe('contract.docx');
    expect(body.clauses[0].originalText).toBe('the words of clause 1');
    expect(body.notes).toEqual([
      'Only the beginning of the document was read.',
    ]);
  });

  it('lets the client page read both answers (CORS)', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    await request(app.getHttpServer())
      .get('/documents')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .expect(200)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
    await request(app.getHttpServer())
      .get(`/documents/${saved.id}`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .expect(200)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers 404 for an id that is not saved', async () => {
    await store.save(analysisNamed('contract.docx'));
    const response = await request(app.getHttpServer())
      .get(`/documents/${OTHER_ID}`)
      .expect(404);
    expect((response.body as { message: string }).message).toBe(
      'There is no saved analysis with this id.',
    );
  });

  it('answers 404 for an address that is not the id the server made', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    for (const path of [
      'abc',
      'contract.json',
      `${saved.id}.json`,
      saved.id.toUpperCase(),
      `${saved.id}%20`,
    ]) {
      await request(app.getHttpServer()).get(`/documents/${path}`).expect(404);
    }
  });

  it('does not give a file outside the data folder', async () => {
    await writeFile(join(root, 'outside.json'), '{"secret": "leaked"}');
    for (const path of [
      '..%2Foutside',
      '..%2F..%2Foutside',
      '%2e%2e%2foutside',
      '..%5Coutside',
    ]) {
      const response = await request(app.getHttpServer()).get(
        `/documents/${path}`,
      );
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('leaked');
    }
  });

  it('answers 500 with a fixed message for a saved file that was damaged, without its content', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${OTHER_ID}.json`),
      '{"documentName": "secret-divorce.docx", "clauses": [',
    );
    const response = await request(app.getHttpServer())
      .get(`/documents/${OTHER_ID}`)
      .expect(500);
    expect((response.body as { message: string }).message).toBe(
      DAMAGED_MESSAGE,
    );
    expect(JSON.stringify(response.body)).not.toContain('secret-divorce');
  });

  it('counts a damaged file in the list and still lists the others', async () => {
    const good = await store.save(analysisNamed('good.docx'));
    await writeFile(join(dir, `${OTHER_ID}.json`), 'not json');
    const response = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);
    const body = response.body as DocumentList;
    expect(body.unreadable).toBe(1);
    expect(body.documents.map((item) => item.id)).toEqual([good.id]);
  });
});

describe('DELETE /documents/:id (e2e)', () => {
  let app: INestApplication<App>;
  let root = '';
  let dir = '';
  let store: FileDocumentStore;

  beforeEach(async () => {
    root = await makeTempDir();
    dir = join(root, 'data');
    store = new FileDocumentStore(dir);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DOCUMENT_STORE)
      .useValue(store)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useLogger(false);
    configureApp(app, {});
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await removeTempDir(root);
  });

  it('deletes one saved analysis, answers 204 with no body, and leaves the others', async () => {
    const kept = await store.save(
      analysisNamed('kept.docx'),
      new Date(Date.UTC(2026, 0, 1)),
    );
    const gone = await store.save(
      analysisNamed('gone.docx'),
      new Date(Date.UTC(2026, 5, 1)),
    );

    const response = await request(app.getHttpServer())
      .delete(`/documents/${gone.id}`)
      .expect(204);
    // A 204 answer has no body. superagent leaves `text` empty or unset.
    expect(response.text || '').toBe('');
    expect(response.body).toEqual({});

    expect(existsSync(join(dir, `${gone.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${kept.id}.json`))).toBe(true);
    await request(app.getHttpServer()).get(`/documents/${gone.id}`).expect(404);
    await request(app.getHttpServer()).get(`/documents/${kept.id}`).expect(200);
    const list = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);
    const body = list.body as DocumentList;
    expect(body.total).toBe(1);
    expect(body.documents.map((item) => item.id)).toEqual([kept.id]);
  });

  it('answers 404 when the same analysis is deleted again', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    await request(app.getHttpServer())
      .delete(`/documents/${saved.id}`)
      .expect(204);
    const response = await request(app.getHttpServer())
      .delete(`/documents/${saved.id}`)
      .expect(404);
    expect((response.body as { message: string }).message).toBe(
      'There is no saved analysis with this id.',
    );
  });

  it('answers 404 for an id that is not saved, and deletes nothing', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    await request(app.getHttpServer())
      .delete(`/documents/${OTHER_ID}`)
      .expect(404);
    expect(existsSync(join(dir, `${saved.id}.json`))).toBe(true);
  });

  it('answers 404 for an address that is not the id the server made, and deletes nothing', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    for (const path of [
      'abc',
      '*',
      'contract.json',
      `${saved.id}.json`,
      saved.id.toUpperCase(),
      `${saved.id}%20`,
      `..%2Fdata%2F${saved.id}`,
    ]) {
      await request(app.getHttpServer())
        .delete(`/documents/${path}`)
        .expect(404);
    }
    expect(existsSync(join(dir, `${saved.id}.json`))).toBe(true);
  });

  it('does not delete a file outside the data folder', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, 'outside.json'), '{"keep": "me"}');
    for (const path of [
      '..%2Foutside',
      '..%2F..%2Foutside',
      '%2e%2e%2foutside',
      '..%5Coutside',
    ]) {
      await request(app.getHttpServer())
        .delete(`/documents/${path}`)
        .expect(404);
    }
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe(
      '{"keep": "me"}',
    );
  });

  it('has no address that deletes all the analyses', async () => {
    const one = await store.save(analysisNamed('one.docx'));
    const two = await store.save(analysisNamed('two.docx'));
    for (const path of ['/documents', '/documents/', '/']) {
      await request(app.getHttpServer()).delete(path).expect(404);
    }
    expect(existsSync(join(dir, `${one.id}.json`))).toBe(true);
    expect(existsSync(join(dir, `${two.id}.json`))).toBe(true);
  });

  it('deletes a saved file that was damaged, so that it can be cleaned up', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${OTHER_ID}.json`), 'not json');
    const before = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);
    expect((before.body as DocumentList).unreadable).toBe(1);

    await request(app.getHttpServer())
      .delete(`/documents/${OTHER_ID}`)
      .expect(204);

    const after = await request(app.getHttpServer())
      .get('/documents')
      .expect(200);
    expect((after.body as DocumentList).unreadable).toBe(0);
  });

  it('answers 500 with a fixed message, without a path, when the file cannot be removed', async () => {
    // A folder with the name of the file cannot be removed like a file.
    const folder = join(dir, `${OTHER_ID}.json`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'inside.txt'), 'keep me');
    const response = await request(app.getHttpServer())
      .delete(`/documents/${OTHER_ID}`)
      .expect(500);
    expect((response.body as { message: string }).message).toBe(
      DELETE_FAILED_MESSAGE,
    );
    expect(JSON.stringify(response.body)).not.toContain(root);
    expect(await readFile(join(folder, 'inside.txt'), 'utf8')).toBe('keep me');
  });

  it('lets the client page send the request (CORS)', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    await request(app.getHttpServer())
      .delete(`/documents/${saved.id}`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .expect(204)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('answers the browser pre-check (OPTIONS) for the client page, allows DELETE, and deletes nothing', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    const response = await request(app.getHttpServer())
      .options(`/documents/${saved.id}`)
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .set('Access-Control-Request-Method', 'DELETE')
      .expect(204)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
    expect(String(response.headers['access-control-allow-methods'])).toContain(
      'DELETE',
    );
    expect(existsSync(join(dir, `${saved.id}.json`))).toBe(true);
  });

  it('does not allow other pages to send it (CORS), and the pre-check deletes nothing', async () => {
    const saved = await store.save(analysisNamed('contract.docx'));
    const response = await request(app.getHttpServer())
      .options(`/documents/${saved.id}`)
      .set('Origin', 'http://other.example')
      .set('Access-Control-Request-Method', 'DELETE');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(existsSync(join(dir, `${saved.id}.json`))).toBe(true);
  });
});

describe('the store of the real server (e2e)', () => {
  let root = '';
  let before: string | undefined;

  beforeEach(async () => {
    root = await makeTempDir();
    before = process.env.DATA_DIR;
  });

  afterEach(async () => {
    if (before === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = before;
    }
    await removeTempDir(root);
  });

  it('keeps the analyses in the folder that DATA_DIR names', async () => {
    process.env.DATA_DIR = join(root, 'configured');
    // The store is not replaced here: this is the store the real server uses.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = moduleFixture.createNestApplication();
    app.useLogger(false);
    configureApp(app, {});
    await app.init();
    try {
      const store = moduleFixture.get<FileDocumentStore>(DOCUMENT_STORE);
      const saved = await store.save(analysisNamed('contract.docx'));
      expect(existsSync(join(root, 'configured', `${saved.id}.json`))).toBe(
        true,
      );
      const response = await request(app.getHttpServer())
        .get(`/documents/${saved.id}`)
        .expect(200);
      expect((response.body as SavedAnalysis).documentName).toBe(
        'contract.docx',
      );
    } finally {
      await app.close();
    }
  });
});
