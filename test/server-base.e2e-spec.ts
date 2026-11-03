import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DEFAULT_CLIENT_ORIGIN, configureApp } from './../src/app.setup';

describe('Server base (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // An empty environment, so the test does not depend on your shell settings.
    configureApp(app, {});
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET) says the server is running', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('lets the client page call the server (CORS)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .expect(200)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });

  it('does not allow other pages to call the server (CORS)', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://other.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the browser pre-check (OPTIONS) for the client page', () => {
    return request(app.getHttpServer())
      .options('/health')
      .set('Origin', DEFAULT_CLIENT_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204)
      .expect('Access-Control-Allow-Origin', DEFAULT_CLIENT_ORIGIN);
  });
});
