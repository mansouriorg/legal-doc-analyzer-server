import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { describeAiSettings, readAiSettings } from './ai-settings';
import {
  configureApp,
  describeListenHost,
  getClientOrigins,
  getListenHost,
  getPort,
} from './app.setup';
import { getDataDir } from './document-store';
import { loadEnvFileIfPresent } from './env-file';
import { describeSaveSetting, readSaveSetting } from './save-setting';

async function bootstrap() {
  // The settings file is read first, so PORT, CLIENT_ORIGIN and the AI
  // settings can come from it.
  const hasEnvFile = loadEnvFileIfPresent();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const port = getPort();
  const host = getListenHost();
  await app.listen(port, host);
  Logger.log(`Server is listening on port ${port}`, 'Bootstrap');
  const listening = describeListenHost();
  if (listening.isWarning) {
    Logger.warn(listening.text, 'Bootstrap');
  } else {
    Logger.log(listening.text, 'Bootstrap');
  }
  const saving = describeSaveSetting(readSaveSetting(), getDataDir());
  if (saving.isWarning) {
    Logger.warn(saving.text, 'Bootstrap');
  } else {
    Logger.log(saving.text, 'Bootstrap');
  }
  Logger.log(
    `Allowed client pages: ${getClientOrigins().join(', ')}`,
    'Bootstrap',
  );
  Logger.log(
    hasEnvFile
      ? 'Settings: the .env file was read'
      : 'Settings: there is no .env file, so defaults and shell values are used',
    'Bootstrap',
  );
  const ai = readAiSettings();
  if (ai.problems.length > 0) {
    Logger.warn(describeAiSettings(ai), 'Bootstrap');
  } else {
    Logger.log(describeAiSettings(ai), 'Bootstrap');
  }
}
void bootstrap();
