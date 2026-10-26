import { bestSlipRotation, checkSlipConsistency, lineConfidences, meanTokenLogProbability, normalizeSlip, parseSlip, parseSlipLine } from '../slip';
import type { LexiconData } from '../lexicon';

test.each([
  ['Milk (2kg)', 'milk', 2, 'kg', null],
  ['Rice (200g)', 'rice', 200, 'g', null],
  ['Vanilla essence (10ml)', 'vanilla essence', 10, 'ml', null],
  ['1 Kg Baking Soda Powder', 'baking soda powder', 1, 'kg', null],
  ['2.5 Kg Refined Sugar', 'refined sugar', 2.5, 'kg', null],
  ['1 dozen Eggs', 'eggs', 1, 'dozen', null],
  ['Tomato (0.5 Kg)', 'tomato', 0.5, 'kg', null],
  ['Pistachio', 'pistachio', null, null, null],
  ['Tamatar   5 kg    Rs 300', 'tamatar', 5, 'kg', 300],
  ['Poha 10kg = 550', 'poha', 10, 'kg', 550],
  ['Tel 1 L 160', 'tel', 1, 'l', 160],
  ['Dhaniya 1/2 kg ₹40', 'dhaniya', 0.5, 'kg', 40],
])('parses slip line %s', (text, item, qty, unit, amount) => {
  expect(parseSlipLine(text)).toMatchObject({ item, qty, unit, amount_rupees: amount });
});

test('keeps extra quantities as notes and parses supplier, total, and item line indexes', () => {
  expect(parseSlipLine('Achaar (250g) (1 Bottle)')).toMatchObject({
    item: 'achaar', qty: 250, unit: 'g', notes: ['1 Bottle'],
  });
  const parsed = parseSlip(['Shri Ganesh Traders', '', 'Tamatar 5 kg Rs 300', 'Pyaz 3 kg Rs 105', '-----', 'Total Rs 405']);
  expect(parsed).toMatchObject({
    supplier: 'Shri Ganesh Traders',
    total_rupees: 405,
    lines: [{ index: 2, line: { item: 'tamatar' } }, { index: 3, line: { item: 'pyaz' } }],
  });
});

test('does not mistake an item heading or an unmarked number for supplier/total', () => {
  expect(parseSlip(['Kheer saaman', 'Milk (2kg)', 'Rice (200g)']).supplier).toBeNull();
  expect(parseSlip(['Milk (2kg)', '25']).total_rupees).toBeNull();
});

test('parses right-column money and a bare marked total without treating it as a purchase', () => {
  const parsed = parseSlip([
    'Panera — 500g 320/-',
    'Tata Salt — 75g 5/-',
    'chilly sauce — 250 ml (1 Bottle) 35/-',
    '565/-',
  ]);
  expect(parsed.total_rupees).toBe(565);
  expect(parsed.lines.map(({ line }) => [line.item, line.qty, line.unit, line.amount_rupees])).toEqual([
    ['panera', 500, 'g', 320],
    ['tata salt', 75, 'g', 5],
    ['chilly sauce', 250, 'ml', 35],
  ]);
});

test('parses compact Qwen item rows with separators and an explicit total', () => {
  const parsed = parseSlip([
    'Paneer | 500g | 320/-',
    'Red chilly powder | 100g | 30/-',
    'TOTAL | 350/-',
  ]);
  expect(parsed.total_rupees).toBe(350);
  expect(parsed.lines.map(({ line }) => [line.item, line.qty, line.unit, line.amount_rupees])).toEqual([
    ['paneer', 500, 'g', 320],
    ['red chilly powder', 100, 'g', 30],
  ]);
});

test('line confidence is driven by the least certain digit and missing probabilities are unknown', () => {
  const tokens = [
    ['Milk', 0.99], [' (', 0.99], ['2', 0.1], ['kg)', 0.99], ['\n', 0.99],
    ['Rice', 0.99], [' (', 0.99], ['200', 0.99], ['g)', 0.99],
  ].map(([content, prob]) => ({
    content: String(content),
    probs: [{ tok_str: String(content), prob: Number(prob) }],
  }));
  const confidence = lineConfidences('Milk (2kg)\nRice (200g)', tokens);
  expect(confidence[0]).toBeLessThan(0.15);
  expect(confidence[1]).toBeGreaterThan(0.95);
  expect(lineConfidences('Milk (2kg)', null)).toEqual([0.5]);
});

test('chooses the most probable orientation and keeps original when scores are unavailable', () => {
  expect(bestSlipRotation([-2, -0.2, -1, -0.8])).toEqual({ rotation: 90, scored: true });
  expect(bestSlipRotation([null, null, null, null])).toEqual({ rotation: 0, scored: false });
  expect(meanTokenLogProbability([{ content: 'milk', probs: [{ tok_str: 'milk', prob: Math.exp(-0.4) }] }])).toBeCloseTo(-0.4);
  expect(meanTokenLogProbability([])).toBeNull();
});

test('consistency checks flag missing prices and totals that do not add up', () => {
  const missing = checkSlipConsistency({
    supplier: null, total_rupees: 100, rotation: 0, text: '', warnings: [],
    lines: [
      { item: 'a', qty: null, unit: null, amount_rupees: 60, confidence: 1, text: 'a', notes: [] },
      { item: 'b', qty: null, unit: null, amount_rupees: null, confidence: 1, text: 'b', notes: [] },
    ],
  });
  expect(missing.lines[1].confidence).toBeLessThanOrEqual(0.5);
  expect(missing.lines[1].notes[0]).toContain('price missing');

  const mismatch = checkSlipConsistency({
    supplier: null, total_rupees: 100, rotation: 0, text: '', warnings: [],
    lines: [
      { item: 'a', qty: null, unit: null, amount_rupees: 60, confidence: 1, text: 'a', notes: [] },
      { item: 'b', qty: null, unit: null, amount_rupees: 30, confidence: 1, text: 'b', notes: [] },
    ],
  });
  expect(mismatch.warnings).toHaveLength(1);
  expect(mismatch.lines.every((line) => line.confidence <= 0.5)).toBe(true);
});

test('normalizes lexicon aliases and converts units; close matches remain noted', () => {
  const lexicon: LexiconData = {
    items: { tamatar: 'tomato', pyaaz: 'onion', onion: 'onion' },
    units: {
      kg: { unit: 'kg', factor: 1 },
      g: { unit: 'kg', factor: 0.001 },
      ml: { unit: 'l', factor: 0.001 },
    },
  };
  const result = normalizeSlip({
    supplier: null, lines: [
      { item: 'tamatar', qty: 0.5, unit: 'kg', amount_rupees: null, confidence: 0.9, text: '', notes: [] },
      { item: 'pyaaaz', qty: 1, unit: 'kg', amount_rupees: null, confidence: 0.9, text: '', notes: [] },
      { item: 'rice', qty: 200, unit: 'g', amount_rupees: null, confidence: 0.9, text: '', notes: [] },
      { item: 'vinegar', qty: 700, unit: 'ml', amount_rupees: null, confidence: 0.9, text: '', notes: [] },
      { item: 'hershey', qty: 250, unit: 'ml', amount_rupees: null, confidence: 0.9, text: '', notes: [] },
    ], total_rupees: null, rotation: 0, text: '', warnings: [],
  }, lexicon);
  expect(result.lines.map(({ item, qty, unit }) => [item, qty, unit])).toEqual([
    ['tomato', 0.5, 'kg'], ['onion', 1, 'kg'], ['rice', 0.2, 'kg'], ['vinegar', 0.7, 'l'], ['hershey', 0.25, 'l'],
  ]);
  expect(result.lines[1].notes[0]).toContain("matched 'pyaaz'");
});
