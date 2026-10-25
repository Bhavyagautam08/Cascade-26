// Vocabulary and units, editable while the app runs (Lexicon Drop). Ported from perception/lexicon.py.
// The same lexicon feeds Whisper (as its prompt words), the language model and the rule parser.
export type LexiconData = {
  items?: Record<string, string>; // local word -> ledger item key ("tamatar" -> "tomato")
  units?: Record<string, { unit: string; factor: number }>;
  aliases?: Record<string, string>; // name as said -> customer key
  verbs?: Record<string, string>; // word -> event kind
  numbers?: Record<string, number>;
  prices?: Record<string, number>;
  perishable?: string[];
  [section: string]: unknown;
};

export class Lexicon {
  constructor(public data: LexiconData, private save: (data: LexiconData) => void) {}

  /** Add one entry at runtime and keep it. */
  add(section: string, key: string, value: unknown) {
    const current = (this.data[section] ??= {}) as Record<string, unknown> | string[];
    if (Array.isArray(current)) {
      if (!current.includes(key)) current.push(key);
    } else current[key] = value;
    this.save(this.data);
  }

  /** Words Whisper should expect: local item names and customer names only (no units: see lexicon.py). */
  hotwords(): string {
    const local = Object.entries(this.data.items ?? {})
      .filter(([k, v]) => k.toLowerCase() !== String(v).toLowerCase())
      .map(([k]) => k);
    return [...local, ...Object.keys(this.data.aliases ?? {})].join(' ');
  }

  /** The lexicon as Python's json.dumps(data, ensure_ascii=False) writes it, so prompts match the laptop's. */
  promptBlock(): string {
    return pyJsonDumps(this.data);
  }
}

/** json.dumps with Python's defaults (", " and ": " separators), ensure_ascii=False.
 *  JavaScript can't tell 1.0 from 1; the lexicon's unit factors are floats in Python (data/lexicon.json
 *  writes "factor": 1.0), so a path ending in units.<word>.factor is written the way Python writes a float. */
export function pyJsonDumps(v: unknown, path: string[] = []): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NaN';
    const isFactor = path.length === 3 && path[0] === 'units' && path[2] === 'factor';
    return isFactor && Number.isInteger(v) ? `${v}.0` : String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x, i) => pyJsonDumps(x, [...path, String(i)])).join(', ')}]`;
  return `{${Object.entries(v as object).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x, [...path, k])}`).join(', ')}}`;
}
