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

  promptBlock(): string {
    return JSON.stringify(this.data);
  }
}
