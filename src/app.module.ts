import { Module } from '@nestjs/common';
import { readAiSettings } from './ai-settings';
import { AI_SETTINGS, ANALYZE_TOOLS } from './analyze-document';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AnalyzeController } from './analyze.controller';
import { AskController } from './ask.controller';
import {
  DOCUMENT_STORE,
  FileDocumentStore,
  getDataDir,
} from './document-store';
import { DocumentsController } from './documents.controller';
import { HealthController } from './health.controller';
import { readSaveSetting, SAVE_SETTING } from './save-setting';

@Module({
  imports: [],
  controllers: [
    AppController,
    AnalyzeController,
    AskController,
    DocumentsController,
    HealthController,
  ],
  providers: [
    AppService,
    // Read when the server is created, which is after main.ts has read the .env file.
    { provide: AI_SETTINGS, useFactory: () => readAiSettings() },
    // Nothing is replaced in the real server. The tests put fakes here.
    { provide: ANALYZE_TOOLS, useValue: {} },
    // Where the saved analyses are kept. Read when the server is created too.
    {
      provide: DOCUMENT_STORE,
      useFactory: () => new FileDocumentStore(getDataDir()),
    },
    // Whether the analyses are saved (SAVE_ANALYSES). Read when the server is created too.
    { provide: SAVE_SETTING, useFactory: () => readSaveSetting() },
  ],
})
export class AppModule {}
