import type { LexiconData } from './lexicon';
import { closestItem } from './spelling';

export type SlipLine = {
  item: string;
  qty: number | null;
  unit: string | null;
  amount_rupees: number | null;
  confidence: number;
  text: string;
  notes: string[];
};

export type Slip = {
  supplier: string | null;
  lines: SlipLine[];
  total_rupees: number | null;
  rotation: number;
  text: string;
  warnings: string[];
};

export type SlipTokenProbability = {
  content: string;
  probs: { tok_str: string; prob: number }[];
};

export function meanTokenLogProbability(tokens: SlipTokenProbability[] | null | undefined): number | null {
  const logprobs = (tokens ?? []).flatMap((token) => {
    const probability = token.probs.find((item) => item.tok_str === token.content)?.prob;
    return probability !== undefined && probability > 0 && probability <= 1 ? [Math.log(probability)] : [];
  });
  return logprobs.length ? logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length : null;
}

export function bestSlipRotation(scores: (number | null)[]): { rotation: number; scored: boolean } {
  const rotations = [0, 90, 180, 270];
  let bestIndex = -1;
  for (const [index, score] of scores.entries()) {
    if (index >= rotations.length || score === null || !Number.isFinite(score)) continue;
    if (bestIndex < 0 || score > (scores[bestIndex] as number)) bestIndex = index;
  }
  return bestIndex < 0 ? { rotation: 0, scored: false } : { rotation: rotations[bestIndex], scored: true };
}

type ParsedLine = {
  item: string | null;
  qty: number | null;
  unit: string | null;
  amount_rupees: number | null;
  notes: string[];
  is_total: boolean;
};

const UNIT_WORDS: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gr: 'g',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  ml: 'ml', millilitre: 'ml', milliliter: 'ml',
  dozen: 'dozen', dz: 'dozen',
  pc: 'piece', pcs: 'piece', piece: 'piece', pieces: 'piece',
  packet: 'packet', packets: 'packet', pkt: 'packet', pack: 'packet',
  bottle: 'bottle', bottles: 'bottle', plate: 'plate', plates: 'plate',
};
const TOTAL_WORDS = ['grand total', 'total', 'kul', 'jod', 'yog'];
const NUM = String.raw`\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?`;
const unitPattern = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
const quantityPattern = new RegExp(String.raw`(?<![\w.])(${NUM})\s*(${unitPattern})(?![a-z])`, 'gi');
const moneyPattern = new RegExp(String.raw`(?:rs\.?|inr|₹|=|@)\s*(${NUM})|(${NUM})\s*(?:/-|rs\b|rupees?\b)`, 'i');
const bareNumberPattern = new RegExp(String.raw`(?<![\w.])${NUM}(?![\w.])`, 'g');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumber(value: string): number {
  const clean = value.replace(/,/g, '.').replace(/\s/g, '');
  if (clean.includes('/')) {
    const [numerator, denominator] = clean.split('/').map(Number);
    return numerator / denominator;
  }
  return Number(clean);
}

export function parseSlipLine(text: string): ParsedLine | null {
  const raw = text.trim().replace(/^[-•*|]+|[-•*|]+$/g, '').trim();
  if (!/[a-zA-Z\u0900-\u097f]/.test(raw)) return null;
  const lower = raw.toLowerCase();
  const is_total = TOTAL_WORDS.some((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(lower));
  let rest = raw;
  let qty: number | null = null;
  let unit: string | null = null;
  const notes: string[] = [];

  for (const match of raw.matchAll(quantityPattern)) {
    const value = match[0];
    if (qty === null) {
      qty = parseNumber(match[1]);
      unit = UNIT_WORDS[match[2].toLowerCase()];
    } else {
      notes.push(value.trim());
    }
    const index = rest.indexOf(value);
    if (index >= 0) rest = `${rest.slice(0, index)} ${rest.slice(index + value.length)}`;
  }

  let amount_rupees: number | null = null;
  const money = moneyPattern.exec(rest);
  if (money) {
    amount_rupees = parseNumber(money[1] ?? money[2]);
    rest = `${rest.slice(0, money.index)} ${rest.slice(money.index + money[0].length)}`;
  } else {
    const numbers = [...rest.matchAll(bareNumberPattern)].map((match) => match[0]);
    if (numbers.length) {
      amount_rupees = parseNumber(numbers[numbers.length - 1]);
      rest = rest.replace(bareNumberPattern, ' ');
    }
  }

  const item = rest
    .replace(/[()[\]{}:=₹|/\\\-–—_]+/g, ' ')
    .replace(/\b(rs|inr|rupees?)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,]+|[.,]+$/g, '')
    .toLowerCase() || null;
  return { item, qty, unit, amount_rupees, notes, is_total };
}

function bareAmount(text: string): number | null {
  const match = moneyPattern.exec(text.trim());
  return match && match[0].trim() === text.trim() ? parseNumber(match[1] ?? match[2]) : null;
}

function looksLikeHeading(text: string, lines: string[], index: number): boolean {
  const headingWords = /\b(traders?|store|stores|kirana|mart|shop|enterprises?|& ?sons|bhandar|agency|wholesale|general)\b/i;
  if (!headingWords.test(text)) return false;
  return lines.slice(index + 1).some((line) => {
    const parsed = parseSlipLine(line);
    return !!parsed && (parsed.qty !== null || parsed.amount_rupees !== null);
  });
}

export function parseSlip(lines: string[]): { supplier: string | null; total_rupees: number | null; lines: { index: number; line: ParsedLine }[] } {
  let supplier: string | null = null;
  let total_rupees: number | null = null;
  const items: { index: number; line: ParsedLine }[] = [];
  for (const [index, text] of lines.entries()) {
    const parsed = parseSlipLine(text);
    if (!parsed) {
      const total = bareAmount(text);
      if (total !== null && items.length && total_rupees === null) total_rupees = total;
      continue;
    }
    if (parsed.is_total) {
      total_rupees = parsed.amount_rupees ?? total_rupees;
      continue;
    }
    if (!items.length && supplier === null && parsed.qty === null && parsed.amount_rupees === null && looksLikeHeading(text, lines, index)) {
      supplier = text.trim();
      continue;
    }
    items.push({ index, line: parsed });
  }
  return { supplier, total_rupees, lines: items };
}

export function lineConfidences(content: string, tokens: SlipTokenProbability[] | null | undefined): number[] {
  const perLine: { token: string; logprob: number }[][] = [[]];
  for (const token of tokens ?? []) {
    const prob = token.probs.find((item) => item.tok_str === token.content)?.prob;
    if (prob === undefined || prob <= 0 || prob > 1) continue;
    const logprob = Math.log(prob);
    const parts = token.content.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index) perLine.push([]);
      if (part.trim()) perLine[perLine.length - 1].push({ token: part, logprob });
    }
  }
  const lineCount = content.split('\n').length;
  return Array.from({ length: lineCount }, (_, index) => {
    const evidence = perLine[index] ?? [];
    if (!evidence.length) return 0.5;
    const digits = evidence.filter(({ token }) => /\d/.test(token)).map(({ logprob }) => logprob);
    const logprob = digits.length
      ? Math.min(...digits)
      : evidence.reduce((sum, item) => sum + item.logprob, 0) / evidence.length;
    return Math.round(Math.exp(logprob) * 1000) / 1000;
  });
}

export function checkSlipConsistency(slip: Slip): Slip {
  const lines = slip.lines.map((line) => ({ ...line, notes: [...line.notes] }));
  const warnings = [...slip.warnings];
  const priced = lines.filter((line) => line.amount_rupees !== null);
  if (priced.length && priced.length < lines.length) {
    for (const line of lines) {
      if (line.amount_rupees === null) {
        line.confidence = Math.min(line.confidence, 0.5);
        line.notes.push('price missing (other lines have one)');
      }
    }
  }
  if (slip.total_rupees !== null && priced.length) {
    const sum = priced.reduce((total, line) => total + (line.amount_rupees ?? 0), 0);
    if (Math.abs(sum - slip.total_rupees) > 1) {
      warnings.push(`line prices add up to ${sum}, the slip's total says ${slip.total_rupees}`);
      for (const line of lines) line.confidence = Math.min(line.confidence, 0.5);
    }
  }
  return { ...slip, lines, warnings };
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length];
}

export function normalizeSlip(slip: Slip, lexicon: LexiconData): Slip {
  const items = new Map<string, string>();
  for (const [alias, canonical] of Object.entries(lexicon.items ?? {})) {
    items.set(alias.toLowerCase(), canonical);
    items.set(canonical.toLowerCase(), canonical);
  }
  const units = new Map(Object.entries(lexicon.units ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const lines = slip.lines.map((line) => {
    let item = line.item.trim().toLowerCase();
    const notes = [...line.notes];
    if (items.has(item)) {
      item = items.get(item)!;
    } else {
      const close = [...items.keys()]
        .map((candidate) => ({ candidate, similarity: 1 - levenshtein(item, candidate) / Math.max(item.length, candidate.length, 1) }))
        .filter(({ similarity }) => similarity >= 0.8)
        .sort((a, b) => b.similarity - a.similarity || a.candidate.localeCompare(b.candidate))[0];
      const sounds = close ? null : closestItem(item, lexicon); // "tamattax" -> "tamatar"
      const match = close?.candidate ?? sounds;
      if (match) {
        notes.push(`read as '${item}', matched '${match}'`);
        item = items.get(match) ?? match;
      }
    }
    let { qty, unit } = line;
    const conversion = unit ? units.get(unit.trim().toLowerCase()) : undefined;
    if (conversion) {
      qty = qty === null ? null : Math.round(qty * conversion.factor * 1_000_000) / 1_000_000;
      unit = conversion.unit;
    }
    return { ...line, item, qty, unit: unit?.toLowerCase() ?? null, notes };
  });
  return { ...slip, lines };
}
