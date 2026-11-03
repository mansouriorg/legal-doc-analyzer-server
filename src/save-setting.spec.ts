import {
  NOT_KEPT_NOTE,
  SAVE_FIELD_UNCLEAR_NOTE,
  SAVE_SETTING,
  SAVING_OFF_NOTE,
  decideSaving,
  describeSaveSetting,
  readChoice,
  readSaveSetting,
  type SaveSetting,
} from './save-setting';

const on: SaveSetting = { enabled: true, problem: null };
const off: SaveSetting = { enabled: false, problem: null };
const offBecauseUnclear: SaveSetting = {
  enabled: false,
  problem: 'SAVE_ANALYSES is not true or false, so no analysis is saved.',
};

describe('readChoice', () => {
  it('reads the words for yes, in any letter case and with spaces around them', () => {
    for (const text of ['true', 'TRUE', ' True ', 'yes', 'on', '1', ' 1 ']) {
      expect(readChoice(text)).toBe('yes');
    }
  });

  it('reads the words for no, in any letter case and with spaces around them', () => {
    for (const text of ['false', 'FALSE', ' False ', 'no', 'off', '0', ' 0 ']) {
      expect(readChoice(text)).toBe('no');
    }
  });

  it('does not understand anything else', () => {
    for (const text of [
      '',
      ' ',
      'maybe',
      'flase',
      'tru',
      '2',
      '-1',
      'true false',
    ]) {
      expect(readChoice(text)).toBe('unclear');
    }
  });

  it('does not understand a value that is not text, such as a list sent twice', () => {
    for (const value of [undefined, null, 1, 0, true, false, ['false'], {}]) {
      expect(readChoice(value)).toBe('unclear');
    }
  });
});

describe('readSaveSetting', () => {
  it('saves without the setting, and when it is empty', () => {
    expect(readSaveSetting({})).toEqual(on);
    expect(readSaveSetting({ SAVE_ANALYSES: '' })).toEqual(on);
    expect(readSaveSetting({ SAVE_ANALYSES: '   ' })).toEqual(on);
  });

  it('saves for true, yes, on and 1', () => {
    for (const text of ['true', 'TRUE', 'yes', 'on', '1', ' true ']) {
      expect(readSaveSetting({ SAVE_ANALYSES: text })).toEqual(on);
    }
  });

  it('does not save for false, no, off and 0', () => {
    for (const text of ['false', 'FALSE', 'no', 'off', '0', ' false ']) {
      expect(readSaveSetting({ SAVE_ANALYSES: text })).toEqual(off);
    }
  });

  it('does not save for a value that is not understood, and says so', () => {
    for (const text of ['flase', 'maybe', '2', 'true.']) {
      expect(readSaveSetting({ SAVE_ANALYSES: text })).toEqual(
        offBecauseUnclear,
      );
    }
  });

  it('does not repeat the value in the problem text', () => {
    const result = readSaveSetting({ SAVE_ANALYSES: 'my-secret-value' });
    expect(result.problem).not.toContain('my-secret-value');
  });

  it('reads process.env when no environment is given', () => {
    const before = process.env.SAVE_ANALYSES;
    process.env.SAVE_ANALYSES = 'false';
    try {
      expect(readSaveSetting()).toEqual(off);
    } finally {
      if (before === undefined) {
        delete process.env.SAVE_ANALYSES;
      } else {
        process.env.SAVE_ANALYSES = before;
      }
    }
  });
});

describe('decideSaving', () => {
  it('saves when the setting is on and the request has no field', () => {
    expect(decideSaving(on, undefined)).toEqual({ save: true });
  });

  it('saves when the setting is on and the field says yes', () => {
    for (const text of ['true', 'yes', 'on', '1', ' TRUE ']) {
      expect(decideSaving(on, text)).toEqual({ save: true });
    }
  });

  it('does not save when the field says no, and says that the person asked', () => {
    for (const text of ['false', 'no', 'off', '0', ' FALSE ']) {
      expect(decideSaving(on, text)).toEqual({
        save: false,
        note: NOT_KEPT_NOTE,
      });
    }
  });

  it('does not save when the field is not understood, and says so', () => {
    for (const value of ['', 'maybe', 'flase', ['false'], ['true'], 5, null]) {
      expect(decideSaving(on, value)).toEqual({
        save: false,
        note: SAVE_FIELD_UNCLEAR_NOTE,
      });
    }
  });

  it('does not save when the setting is off, whatever the field says', () => {
    for (const value of [
      undefined,
      'true',
      'false',
      'yes',
      'maybe',
      ['true'],
    ]) {
      expect(decideSaving(off, value)).toEqual({
        save: false,
        note: SAVING_OFF_NOTE,
      });
    }
  });

  it('does not save when the setting was not understood, whatever the field says', () => {
    expect(decideSaving(offBecauseUnclear, 'true')).toEqual({
      save: false,
      note: SAVING_OFF_NOTE,
    });
  });
});

describe('the notes', () => {
  it('say that the analysis was not saved, and what follows from that', () => {
    for (const note of [
      SAVING_OFF_NOTE,
      NOT_KEPT_NOTE,
      SAVE_FIELD_UNCLEAR_NOTE,
    ]) {
      expect(note).toContain('was not saved');
      expect(note).toContain('will not be in the list of saved analyses');
      expect(note).toContain('questions about it cannot be asked later');
      expect(note.length < 500).toBe(true);
    }
  });

  it('differ from each other, and are plain ASCII text', () => {
    const notes = [SAVING_OFF_NOTE, NOT_KEPT_NOTE, SAVE_FIELD_UNCLEAR_NOTE];
    expect(new Set(notes).size).toBe(3);
    for (const note of notes) {
      expect(/^[\x20-\x7e]+$/.test(note)).toBe(true);
    }
  });
});

describe('describeSaveSetting', () => {
  it('names the folder when analyses are saved, as the log always did', () => {
    expect(describeSaveSetting(on, '/work/server/data')).toEqual({
      text: 'Analyses are saved in the folder: /work/server/data',
      isWarning: false,
    });
  });

  it('says that nothing is written when saving is off, and that the analyses in the folder stay', () => {
    const result = describeSaveSetting(off, '/work/server/data');
    expect(result.isWarning).toBe(false);
    expect(result.text).toContain('Saving is turned off (SAVE_ANALYSES)');
    expect(result.text).toContain('no analysis is written to disk');
    expect(result.text).toContain('/work/server/data');
    expect(result.text).toContain('can still be read and deleted');
  });

  it('warns when the value was not understood', () => {
    const result = describeSaveSetting(offBecauseUnclear, '/work/server/data');
    expect(result.isWarning).toBe(true);
    expect(result.text).toContain('SAVE_ANALYSES is not true or false');
    expect(result.text).toContain('no analysis is saved');
    expect(result.text).toContain('can still be read and deleted');
  });
});

describe('the name of the setting for Nest', () => {
  it('is a plain text', () => {
    expect(SAVE_SETTING).toBe('SAVE_SETTING');
  });
});
