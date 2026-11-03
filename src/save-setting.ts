// Whether POST /analyze saves the analyses. The saved files hold quotes from the
// documents, so saving can be turned off in two ways:
//
// - SAVE_ANALYSES=false in the settings of the server turns saving off for
//   every request.
// - The form field "save" of one request, with the value false, turns saving
//   off for that one document.
//
// An analysis is saved only when neither says no. A value that is not
// understood also means no: the switch is there to keep quotes off the disk, so
// in doubt the disk is not written.

// The name under which Nest hands the setting to the controller. The tests give
// their own.
export const SAVE_SETTING = 'SAVE_SETTING';

export interface SaveSetting {
  // true: the analyses are saved, unless a request asks for no saving.
  enabled: boolean;
  // Set when SAVE_ANALYSES has a value that is not understood. It is said in
  // the log when the server starts.
  problem: string | null;
}

// Said to the person, as a note of the analysis, when it was not saved.
export const SAVING_OFF_NOTE =
  'Saving is turned off on this server, so this analysis was not saved. It will not be in the list of saved analyses, and questions about it cannot be asked later.';
export const NOT_KEPT_NOTE =
  'You asked not to keep this analysis, so it was not saved. It will not be in the list of saved analyses, and questions about it cannot be asked later.';
export const SAVE_FIELD_UNCLEAR_NOTE =
  'The form field "save" was not true or false, so this analysis was not saved. It will not be in the list of saved analyses, and questions about it cannot be asked later.';

export type Choice = 'yes' | 'no' | 'unclear';

const YES = ['true', 'yes', 'on', '1'];
const NO = ['false', 'no', 'off', '0'];

// Reads a value such as true, false, yes, no, on, off, 1 or 0, in any letter
// case and with spaces around it. Anything else, also a value that is not text,
// is unclear.
export function readChoice(value: unknown): Choice {
  if (typeof value !== 'string') {
    return 'unclear';
  }
  const text = value.trim().toLowerCase();
  if (YES.includes(text)) {
    return 'yes';
  }
  if (NO.includes(text)) {
    return 'no';
  }
  return 'unclear';
}

// The setting SAVE_ANALYSES. Without it, or when it is empty, the analyses are
// saved. A value that is not understood turns saving off.
export function readSaveSetting(
  env: NodeJS.ProcessEnv = process.env,
): SaveSetting {
  const text = (env.SAVE_ANALYSES ?? '').trim();
  if (text === '') {
    return { enabled: true, problem: null };
  }
  const choice = readChoice(text);
  if (choice === 'yes') {
    return { enabled: true, problem: null };
  }
  if (choice === 'no') {
    return { enabled: false, problem: null };
  }
  return {
    enabled: false,
    problem: 'SAVE_ANALYSES is not true or false, so no analysis is saved.',
  };
}

// What happens to one request: it is saved, or it is not and the note says why.
export type SaveDecision = { save: true } | { save: false; note: string };

// `field` is the value of the form field "save" of the request, and undefined
// when the request has none.
export function decideSaving(
  setting: SaveSetting,
  field: unknown,
): SaveDecision {
  if (setting.enabled === false) {
    return { save: false, note: SAVING_OFF_NOTE };
  }
  if (field === undefined) {
    return { save: true };
  }
  const choice = readChoice(field);
  if (choice === 'yes') {
    return { save: true };
  }
  return {
    save: false,
    note: choice === 'no' ? NOT_KEPT_NOTE : SAVE_FIELD_UNCLEAR_NOTE,
  };
}

export interface SaveDescription {
  text: string;
  isWarning: boolean;
}

// What the log says when the server starts, and whether it is a warning.
export function describeSaveSetting(
  setting: SaveSetting,
  dataDir: string,
): SaveDescription {
  if (setting.problem !== null) {
    return {
      text: `${setting.problem} The analyses that are already in the folder ${dataDir} can still be read and deleted.`,
      isWarning: true,
    };
  }
  if (setting.enabled === false) {
    return {
      text: `Saving is turned off (SAVE_ANALYSES): no analysis is written to disk. The analyses that are already in the folder ${dataDir} can still be read and deleted.`,
      isWarning: false,
    };
  }
  return {
    text: `Analyses are saved in the folder: ${dataDir}`,
    isWarning: false,
  };
}
