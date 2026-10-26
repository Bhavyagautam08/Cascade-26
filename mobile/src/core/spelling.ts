// Item names heard or read slightly wrong ("tamattar", "tamattax", "chini") are matched to the shop's own
// words (the lexicon), and every change is reported so the vendor sees it and can undo it.
//
// Matching compares a sound-alike key (doubled letters collapsed, ee->i, oo->u, aa->a), so the usual
// Hinglish spelling swings cost nothing. On top of that one letter may differ for words of 5+ letters.
// The first letter must agree and the closest match must be unique; anything else is left as said.
// Words the shop already knows (units, verbs, number words, customer names) are never touched.
import type { LexiconData } from './lexicon';

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** "tamattar" -> "tamatar", "cheeni" -> "chini", "aaloo" -> "alu". */
export function soundKey(word: string): string {
  return word.toLowerCase().replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/(.)\1+/g, '$1');
}

const MIN_WORD = 4; // shorter words ("do", "mila", "tel") are too easy to confuse
const MIN_FUZZY = 5; // a differing letter is allowed only from this length on

/** Single-word item names the shop uses, each with the ledger item it means. */
function itemWords(lex: LexiconData): Map<string, string> {
  const out = new Map<string, string>();
  const add = (word: string, canonical: string) => {
    const w = word.trim().toLowerCase();
    if (w && !w.includes(' ')) out.set(w, canonical);
  };
  for (const [local, canonical] of Object.entries(lex.items ?? {})) {
    add(local, canonical);
    add(canonical, canonical);
  }
  for (const item of Object.keys(lex.prices ?? {})) add(item, item);
  for (const item of lex.perishable ?? []) add(item, item);
  return out;
}

function knownWords(lex: LexiconData): Set<string> {
  const out = new Set<string>();
  for (const section of [lex.units, lex.verbs, lex.numbers, lex.aliases]) {
    for (const phrase of Object.keys(section ?? {})) for (const w of phrase.toLowerCase().split(/\s+/)) out.add(w);
  }
  for (const v of Object.values(lex.aliases ?? {})) out.add(String(v).toLowerCase());
  return out;
}

/** The shop's item word closest to `word`, or null when none is close enough or two different items tie. */
export function closestItem(word: string, lex: LexiconData): string | null {
  const w = word.toLowerCase();
  if (w.length < MIN_WORD) return null;
  const words = itemWords(lex);
  if (words.has(w)) return w;
  const key = soundKey(w);
  let best: { word: string; d: number; raw: number }[] = [];
  for (const candidate of words.keys()) {
    if (candidate[0] !== w[0]) continue;
    const ck = soundKey(candidate);
    if (ck.length < MIN_WORD - 1) continue;
    const d = levenshtein(key, ck);
    if (d > (key.length >= MIN_FUZZY ? 1 : 0)) continue; // "achha" (acha) must not become "achaar"
    const raw = levenshtein(w, candidate);
    if (!best.length || d < best[0].d) best = [{ word: candidate, d, raw }];
    else if (d === best[0].d) best.push({ word: candidate, d, raw });
  }
  if (!best.length) return null;
  if (new Set(best.map((b) => words.get(b.word))).size > 1) return null; // two different items: don't guess
  return best.sort((a, b) => a.raw - b.raw || a.word.localeCompare(b.word))[0].word;
}

export type SpellingFix = { from: string; to: string };

/** Replace near-miss item words in `text` with the shop's spelling; returns what was changed. */
export function fixItemSpelling(text: string, lex: LexiconData): { text: string; fixes: SpellingFix[] } {
  const known = knownWords(lex);
  const words = itemWords(lex);
  const fixes: SpellingFix[] = [];
  const out = text.replace(/[A-Za-z]+/g, (word) => {
    const w = word.toLowerCase();
    if (known.has(w) || words.has(w)) return word;
    const to = closestItem(w, lex);
    if (!to) return word;
    fixes.push({ from: word, to });
    return to;
  });
  return { text: out, fixes };
}

/** The vendor's own word for a ledger item ("tomato" -> "tamatar"), for display. */
export function itemLabel(item: string, lex: LexiconData): string {
  const local = Object.entries(lex.items ?? {}).find(([k, v]) => v === item && k.toLowerCase() !== item.toLowerCase());
  return local ? local[0] : item;
}
