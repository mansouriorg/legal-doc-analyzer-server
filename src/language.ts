// Finds the language of a contract from the words it uses most, so that the
// request to the AI service can name the language the answer must be written in.
//
// Why the code does this: when a small model was only told "write in the
// language of the document", it chose another language. In a live test with
// qwen2.5:7b an English contract was answered in Romanian, and two short
// English contracts in Finnish and Spanish, with the quotes translated, so no
// quote was found in the document. The name returned here comes from the fixed
// list below and never from the document, so the document cannot choose it.

// Common words of each language, written without accents (accents are removed
// from the text before the comparison). A word is in one list only. A test
// checks this, because a word in two lists would favour neither language.
const WORD_LISTS: Record<string, string> = {
  English:
    'the and of to is that shall this for with be any by or are may not which such party parties agreement will its their has have been under from it at',
  French:
    'les des du et est pour une dans sans par aux cette sont au sur qui peut doit pas leur ses tout toute contrat partie avec ce elle ils',
  Spanish:
    'el los las sus cualquier sin desde segun cuando donde dicho dicha mismo obligaciones derechos proveedor debera podra hasta tambien',
  German:
    'der die und nicht ist mit von zu den dem ein eine auf fur werden oder auch sich vertrag partei parteien wird sind kann bei nach einer eines',
  Italian:
    'il di che sono dei gli nel alla della delle nella dal anche cui uno essere contratto parti agli dalla sul',
  Portuguese:
    'os uma nao sao pelo pela pelos pelas ao aos seu sua seus suas qualquer deve podem serem ele ela obrigacoes direitos fornecedor',
};

export const WORDS_BY_LANGUAGE: Record<string, string[]> = Object.fromEntries(
  Object.entries(WORD_LISTS).map(([name, words]) => [name, words.split(' ')]),
);

const WORD_SETS: Array<[string, Set<string>]> = Object.entries(
  WORDS_BY_LANGUAGE,
).map(([name, words]) => [name, new Set(words)]);

// The characters are written as codes, so that this file stays plain ASCII.
function chars(...codes: number[]): string {
  return String.fromCharCode(...codes);
}
const COMBINING_MARKS = new RegExp(`[${chars(0x300)}-${chars(0x36f)}]`, 'g');
const ARABIC_LETTERS = new RegExp(`[${chars(0x621)}-${chars(0x64a)}]`, 'g');

// Only the beginning is read: it is enough, and a long document stays fast.
const MAX_CHARS_READ = 20000;
// A language needs this many common words, and this many times more than the
// next language. Otherwise the language is not known.
const MIN_HITS = 3;
const MIN_LEAD = 1.5;
// Arabic is recognised by its letters: at least this share of all letters.
const MIN_ARABIC_LETTERS = 20;
const MIN_ARABIC_SHARE = 0.4;

// Returns "English", "French", "Spanish", "German", "Italian", "Portuguese" or
// "Arabic", or null when the language is not clear (a short text, a mix, or a
// language that is not in the list).
export function detectLanguage(text: string): string | null {
  const sample = text.slice(0, MAX_CHARS_READ);

  const words =
    sample
      .toLowerCase()
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .match(/[a-z]+/g) ?? [];

  const arabic = (sample.match(ARABIC_LETTERS) ?? []).length;
  const latin = words.join('').length;
  if (
    arabic >= MIN_ARABIC_LETTERS &&
    arabic >= (arabic + latin) * MIN_ARABIC_SHARE
  ) {
    return 'Arabic';
  }

  let best: string | null = null;
  let bestHits = 0;
  let secondHits = 0;
  for (const [name, set] of WORD_SETS) {
    const hits = words.filter((word) => set.has(word)).length;
    if (hits > bestHits) {
      secondHits = bestHits;
      bestHits = hits;
      best = name;
    } else if (hits > secondHits) {
      secondHits = hits;
    }
  }

  if (bestHits < MIN_HITS || bestHits < secondHits * MIN_LEAD) {
    return null;
  }
  return best;
}
