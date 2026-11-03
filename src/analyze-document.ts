import {
  AiRequestCancelledError,
  AiServiceError,
  analyzeText,
  type AnalysisResult,
} from './ai-analyzer';
import type { AiSettingsResult } from './ai-settings';
import { extractText, type TextReaders } from './text-extractor';
import type { UploadedDocument } from './upload-rules';

// The whole analysis of one uploaded document: read its text, send the text to
// the AI service, and return the result with the notes of both steps.

// The names under which Nest hands the AI settings and the tools to the
// controller (see app.module.ts). The tests give their own.
export const AI_SETTINGS = 'AI_SETTINGS';
export const ANALYZE_TOOLS = 'ANALYZE_TOOLS';

// Things that only the tests replace.
export interface AnalyzeTools {
  // The readers of the text of a PDF and of a Word file.
  readers?: TextReaders;
  // The fetch that calls the AI service. Default: the fetch of Node.
  fetchImpl?: typeof fetch;
}

export const NOT_SET_UP_MESSAGE =
  'This server is not set up to analyze documents: no AI service is configured. If you run the server, see "Setting up the AI service" in the README.';
export const INVALID_SETTINGS_MESSAGE =
  'This server is not set up to analyze documents: the settings of the AI service are not valid. If you run the server, read the "AI service" line in its log and see "Setting up the AI service" in the README.';

// With a signal "cancel", the caller says that nobody waits for the result any
// more (the browser left). Then an AiRequestCancelledError is thrown: before
// the file is read, if the signal is aborted by then, or when the call to the
// AI service is dropped.
export async function analyzeDocument(
  file: UploadedDocument,
  ai: AiSettingsResult,
  tools: AnalyzeTools = {},
  cancel?: AbortSignal,
): Promise<AnalysisResult> {
  // Checked first, because reading a large PDF takes time that would be wasted.
  if (ai.settings === null) {
    throw new AiServiceError(
      'not-configured',
      ai.problems.length > 0 ? INVALID_SETTINGS_MESSAGE : NOT_SET_UP_MESSAGE,
    );
  }

  // Reading a large file takes time and blocks the server, so it is not
  // started for a browser that has left.
  if (cancel?.aborted === true) {
    throw new AiRequestCancelledError();
  }

  const extracted = await extractText(file, tools.readers);
  const analysis = await analyzeText({
    settings: ai.settings,
    documentName: file.originalname,
    text: extracted.text,
    fetchImpl: tools.fetchImpl,
    cancel,
  });

  // The warnings of the analysis come first (for example that the document
  // holds words aimed at an AI), then what happened while reading the file.
  const notes = Array.from(new Set([...analysis.notes, ...extracted.notes]));
  return { ...analysis, notes };
}
