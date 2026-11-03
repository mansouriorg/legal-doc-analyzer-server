import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAX_ANSWER_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_QUESTION_CHARS,
  MESSAGES_SENT,
  MESSAGE_CHARS_SENT,
} from './document-chat';

// These tests read the settings files of the server. They keep the fixes of
// update 8 from being undone by accident.

const root = join(__dirname, '..');

function read(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

function readExclude(name: string): string[] {
  const config = JSON.parse(read(name)) as { exclude?: string[] };
  return config.exclude ?? [];
}

describe('project settings', () => {
  it('keeps the backup folder of the update commands out of the build', () => {
    // Otherwise the build also compiles the backed-up copies of the source
    // files, and the program ends up in dist/src instead of dist.
    expect(readExclude('tsconfig.build.json')).toContain('.update-backup');
  });

  it('keeps the backup folder out of the type check', () => {
    expect(readExclude('tsconfig.json')).toContain('.update-backup');
  });

  it('keeps the backup folder out of git', () => {
    expect(read('.gitignore').split('\n')).toContain('/.update-backup');
  });

  it('keeps the saved analyses and the folders of the tests out of git', () => {
    const lines = read('.gitignore').split('\n');
    expect(lines).toContain('/data');
    expect(lines).toContain('/.tmp-tests');
  });

  it('starts the server on the configured port with the client page allowed', () => {
    const main = read('src/main.ts');
    expect(main).toContain('configureApp(app)');
    expect(main).toContain('getPort()');
    expect(main).not.toContain('process.env.PORT');
  });

  it('has the health endpoint in the app module', () => {
    expect(read('src/app.module.ts')).toMatch(
      /controllers: \[[^\]]*HealthController/,
    );
  });

  it('reads the .env file before it creates the app', () => {
    const main = read('src/main.ts');
    const reading = main.indexOf('loadEnvFileIfPresent()');
    const creating = main.indexOf('NestFactory.create');
    expect(reading).not.toBe(-1);
    expect(reading < creating).toBe(true);
  });

  it('keeps .env files out of git, but not the template .env.example', () => {
    const lines = read('.gitignore').split('\n');
    expect(lines).toContain('.env');
    for (const pattern of ['.env*', '.env.*', '.env.example']) {
      expect(lines).not.toContain(pattern);
    }
  });

  it('has no values in the template .env.example', () => {
    const settings = read('.env.example')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line));
    expect(settings.length > 0).toBe(true);
    for (const line of settings) {
      expect(line.endsWith('=')).toBe(true);
    }
  });

  it('lists every AI_ setting that the code reads in .env.example and in the README', () => {
    const names = Array.from(
      new Set(read('src/ai-settings.ts').match(/AI_[A-Z_]+/g) ?? []),
    );
    expect(names.length > 0).toBe(true);
    for (const name of names) {
      expect(read('.env.example')).toContain(name);
      expect(read('README.md')).toContain(name);
    }
  });

  it('lists DATA_DIR in .env.example and in the README', () => {
    expect(read('src/document-store.ts')).toContain('DATA_DIR');
    expect(read('.env.example')).toContain('DATA_DIR');
    expect(read('README.md')).toContain('DATA_DIR');
  });

  it('saves the analyses of POST /analyze in the store of the app module', () => {
    const controller = read('src/analyze.controller.ts');
    expect(controller).toContain('@Inject(DOCUMENT_STORE)');
    expect(controller).toContain('this.store.save(analysis)');
    expect(read('src/app.module.ts')).toMatch(/provide: DOCUMENT_STORE,/);
  });

  it('says in the log which folder the analyses are saved in, or that saving is off', () => {
    expect(read('src/main.ts')).toContain(
      'describeSaveSetting(readSaveSetting(), getDataDir())',
    );
    expect(read('src/save-setting.ts')).toContain(
      'Analyses are saved in the folder: ',
    );
    expect(read('src/app.module.ts')).toContain('getDataDir()');
  });

  it('says in the README that POST /analyze saves, and not that nothing does', () => {
    const readme = read('README.md');
    expect(readme).toContain('also has the `id` and `savedAt`');
    expect(readme).toContain('`POST /analyze` writes to it');
    expect(readme).not.toContain('Nothing is saved');
    expect(readme).not.toContain('nothing saves');
    expect(readme).not.toContain('Nothing saves');
    expect(readme).not.toContain('and saving the analyses of');
    expect(readme).not.toContain('so the folder is not made');
    expect(read('.env.example')).toContain(
      'POST /analyze saves every analysis',
    );
  });

  it('has the documents endpoints in the app module', () => {
    const appModule = read('src/app.module.ts');
    expect(appModule).toMatch(/controllers: \[[^\]]*DocumentsController/);
    expect(appModule).toMatch(/provide: DOCUMENT_STORE,[^}]*getDataDir\(\)/);
  });

  it('lists the documents endpoints in the README', () => {
    const readme = read('README.md');
    expect(readme).toContain('- `GET /documents` - ');
    expect(readme).toContain('- `GET /documents/:id` - ');
  });

  it('lists the delete endpoint in the README, and no longer says that there is none', () => {
    const readme = read('README.md');
    expect(readme).toContain('- `DELETE /documents/:id` - ');
    expect(readme).toContain('`DELETE /documents` is a 404');
    expect(readme).not.toContain('There is no delete endpoint yet');
    expect(readme).not.toContain('a way to delete a saved analysis');
    expect(readme).not.toContain('The server never removes an analysis');
    expect(read('.env.example')).toContain('DELETE /documents/:id');
    expect(read('.env.example')).not.toContain('never deletes');
  });

  it('listens on the address from LISTEN_HOST', () => {
    const main = read('src/main.ts');
    expect(main).toContain('getListenHost()');
    expect(main).toContain('app.listen(port, host)');
    expect(main).toContain('describeListenHost()');
    expect(main).not.toContain('process.env.LISTEN_HOST');
  });

  it('lists LISTEN_HOST in .env.example and in the README', () => {
    expect(read('src/app.setup.ts')).toContain('LISTEN_HOST');
    expect(read('.env.example')).toContain('LISTEN_HOST');
    expect(read('README.md')).toContain('LISTEN_HOST');
  });

  it('lists the ask endpoint in the README, and no longer says that it is not built', () => {
    const readme = read('README.md');
    expect(readme).toContain('- `POST /documents/:id/ask` - ');
    expect(readme).toContain('### Asking questions about a saved analysis');
    expect(readme).not.toContain('Not built yet');
    expect(readme).not.toContain('is not built yet');
    expect(read('.env.example')).toContain('POST /documents/:id/ask');
  });

  it('states the limits of the ask endpoint in the README as the code has them', () => {
    const readme = read('README.md');
    for (const text of [
      `a question of at most ${MAX_QUESTION_CHARS} characters`,
      `a history of at most ${MAX_HISTORY_MESSAGES} messages`,
      `of at most ${MAX_MESSAGE_CHARS} characters each`,
      `The answer is cut at ${MAX_ANSWER_CHARS} characters`,
      `Only the latest ${MESSAGES_SENT} are sent`,
      `each cut to ${MESSAGE_CHARS_SENT} characters`,
    ]) {
      expect(readme).toContain(text);
    }
  });

  it('has the ask endpoint in the app module, with the AI settings and the store it needs', () => {
    expect(read('src/app.module.ts')).toMatch(
      /controllers: \[[^\]]*AskController/,
    );
    const controller = read('src/ask.controller.ts');
    expect(controller).toContain("@Controller('documents')");
    expect(controller).toContain("@Post(':id/ask')");
    expect(controller).toContain('@Inject(AI_SETTINGS)');
    expect(controller).toContain('@Inject(DOCUMENT_STORE)');
  });

  it('says in the README that a question sends the saved analysis to the AI service', () => {
    expect(read('README.md')).toContain('with every question about it');
  });

  it('says in the README what the server does when the browser stops waiting for a question', () => {
    const readme = read('README.md');
    const controller = read('src/ask.controller.ts');
    expect(controller).toContain('export const CLIENT_LEFT_STATUS = 499;');
    expect(controller).toContain('@Res({ passthrough: true })');
    expect(read('src/ai-analyzer.ts')).toContain('AbortSignal.any(');
    expect(readme).toContain('  - 499: the browser dropped the request before');
    expect(readme).toContain(
      '- Stopping: the browser can drop the request before the answer is ready',
    );
    expect(readme).toContain('`src/client-gone.ts`');
    expect(readme).toContain('`AiRequestCancelledError`');
    expect(readme).toContain(
      'Ollama 0.40.13 with qwen2.5:7b ended the question',
    );
    expect(readme).not.toContain('was not tried with a real Ollama model');
    expect(readme).toContain('Node.js 20.3 or newer');
    expect(readme).toContain(
      '`POST /analyze` stops in the same way (see "Stopping an analysis" under "Endpoints").',
    );
  });

  it('has the README of this project, with nothing left of the Nest starter text', () => {
    const readme = read('README.md');
    expect(readme.startsWith('# Legal Doc Analyzer - server\n')).toBe(true);
    for (const text of [
      'nestjs.com/img/logo',
      'circleci',
      'opencollective',
      'mau.nestjs.com',
      'Stay in touch',
      'Kamil',
      '## Deployment',
      '## Resources',
      '## Support',
      'Nest is [MIT licensed]',
    ]) {
      expect(readme).not.toContain(text);
    }
  });

  it('has a quick start whose commands exist, and the sections that replace the starter text', () => {
    const readme = read('README.md');
    const scripts = (
      JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    ).scripts;
    for (const name of ['start:dev', 'build', 'test', 'test:e2e']) {
      expect(Object.keys(scripts)).toContain(name);
    }
    expect(readme).toContain('## What it does');
    expect(readme).toContain('## Quick start');
    expect(readme).toContain(
      '3. Copy the settings template: `cp .env.example .env`.',
    );
    expect(readme).toContain('5. Start the server: `pnpm start:dev`.');
    expect(readme).toContain('        AI_BASE_URL=http://127.0.0.1:11434/v1');
    expect(readme).toContain('        AI_MODEL=qwen2.5:7b');
    expect(readme).toContain('open http://127.0.0.1:3001/health in a browser');
    expect(readme).toContain('## Before you open the server to others');
    expect(readme).toContain('## License');
    expect(readme).toContain(
      'No license has been chosen for this project yet.',
    );
  });

  it('says what the live test with a real Ollama showed, and what it did not show', () => {
    const readme = read('README.md');
    expect(readme).toContain('## Tested with a real model');
    expect(readme).toContain('Ollama 0.40.13 and `qwen2.5:7b`');
    expect(readme).toContain('answered in 0.1 seconds, in both of two rounds');
    expect(readme).toContain('the tiny question waited 8.5 seconds');
    expect(readme).toContain('would not show it with this timing');
    expect(readme).toContain(
      'The whole chain (browser, server, Ollama) was not run together for the stop',
    );
    expect(readme).toContain('None of the titles is about the renewal');
    expect(readme).toContain('The script is not part of this repository.');
    expect(readme).toContain('Not tried with a real model:');
  });
  it('reads SAVE_ANALYSES in one place, and gives it to the controller', () => {
    expect(read('src/save-setting.ts')).toContain('SAVE_ANALYSES');
    expect(read('src/app.module.ts')).toMatch(
      /provide: SAVE_SETTING, useFactory: \(\) => readSaveSetting\(\)/,
    );
    const controller = read('src/analyze.controller.ts');
    expect(controller).toContain('@Inject(SAVE_SETTING)');
    expect(controller).toContain('decideSaving(this.saving');
    expect(controller).toContain("'save' in body");
    expect(read('src/main.ts')).not.toContain('process.env.SAVE_ANALYSES');
  });

  it('keeps the store out of the way when an analysis is not saved', () => {
    const controller = read('src/analyze.controller.ts');
    const skipping = controller.indexOf('decision.save === false');
    const saving = controller.indexOf('this.store.save(analysis)');
    expect(skipping).not.toBe(-1);
    expect(skipping < saving).toBe(true);
  });

  it('lists SAVE_ANALYSES in .env.example, as a comment, and in the README', () => {
    expect(read('.env.example')).toContain('# SAVE_ANALYSES=true');
    expect(read('.env.example').split('\n')).not.toContain('SAVE_ANALYSES=');
    expect(read('README.md')).toContain('- `SAVE_ANALYSES` - ');
  });

  it('says in the README that saving can be turned off, and not that it cannot', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('There is no setting to turn saving off');
    expect(readme).not.toContain('without asking. There is no');
    expect(readme).toContain('Saving can be turned off in two ways');
    expect(readme).toContain('the form field `save`');
    expect(readme).toContain('A value that is not understood');
    expect(readme).toContain(
      'Turning saving off does not remove the analyses that are already in the folder.',
    );
    expect(readme).toContain(
      'Set `SAVE_ANALYSES=false` to keep them off the disk.',
    );
  });

  it('says in the README what the setting and the field do, and what they do not', () => {
    const readme = read('README.md');
    expect(readme).toContain(
      'Default: `true`. `false` (also `no`, `off` or `0`) turns saving off for every request.',
    );
    expect(readme).toContain(
      'A value that is not one of the words for true or false turns saving off too,',
    );
    expect(readme).toContain(
      'Turning saving off does not delete the analyses that are in the folder.',
    );
    expect(readme).toContain(
      'A `save` field that is not `true` or `false` also means no saving, and `notes` says so.',
    );
    expect(readme).toContain(
      'If it could not be saved, or saving is turned off, it has neither, and a note says so.',
    );
    expect(readme).toContain(
      'Saving can be turned off (`SAVE_ANALYSES`, or `save=false` for one upload).',
    );
    expect(readme).toContain(
      'When saving is off, the server writes nothing, not even the data folder,',
    );
    expect(readme).toContain(
      'Such an analysis is not in `GET /documents`, and `POST /documents/:id/ask` cannot be used for it',
    );
    expect(readme).toContain(
      '`SAVE_ANALYSES=false` in the settings turns it off for every request. The form field `save` with the value `false` turns it off for one request.',
    );
  });

  it('says the same in .env.example, and warns in the log when the value is not understood', () => {
    const example = read('.env.example');
    expect(example).toContain('(unless SAVE_ANALYSES says no, see below)');
    expect(example).toContain(
      'already in the folder stay, and can still be read and deleted',
    );
    expect(example).toContain(
      'A value that is not true or false turns saving off, and',
    );
    expect(example).toContain('# the log says so. Default: true');
    expect(read('src/main.ts')).toContain(
      "if (saving.isWarning) {\n    Logger.warn(saving.text, 'Bootstrap');",
    );
  });
});
