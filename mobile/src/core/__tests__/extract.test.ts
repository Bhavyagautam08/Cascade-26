// The model's JSON is checked like the laptop's pydantic check (extractor.LLMOutput); bad shapes are refused.
import { parseExtraction } from '../extract';
import { ModelOutputInvalid } from '../ledger';

const ok = '{"is_transaction": true, "events": [{"kind": "purchase", "item": "tomato", "qty": 3, "unit": "kg", "amount_rupees": 180, "party": null, "confidence": 0.9}, {"kind": "credit_given", "item": null, "qty": null, "unit": null, "amount_rupees": 60, "party": "sharma", "confidence": 0.85}]}';

test('a valid answer becomes candidate events with the source and the text', () => {
  const r = parseExtraction(ok, 'raw text', 'manual');
  expect(r.is_transaction).toBe(true);
  expect(r.events.map((e) => [e.kind, e.item, e.qty, e.amount_rupees, e.party, e.source, e.raw])).toEqual([
    ['purchase', 'tomato', 3, 180, null, 'manual', 'raw text'],
    ['credit_given', null, null, 60, 'sharma', 'manual', 'raw text'],
  ]);
});

test('chatter: is_transaction false, no events', () => {
  expect(parseExtraction('{"is_transaction": false, "events": []}', 'x', 'voice')).toEqual({ is_transaction: false, events: [] });
});

test('accepts llama.cpp assistant markers around a valid JSON answer', () => {
  expect(parseExtraction('<|im_start|>assistant\n{"is_transaction": false, "events": []}<|im_end|>', 'x', 'manual'))
    .toEqual({ is_transaction: false, events: [] });
});

test('is_transaction true with no events counts as not a transaction (extractor.py)', () => {
  expect(parseExtraction('{"is_transaction": true, "events": []}', 'x', 'voice').is_transaction).toBe(false);
});

test.each([
  ['not JSON', '{"is_transaction": true, "events": ['],
  ['unknown kind', '{"is_transaction": true, "events": [{"kind": "gift", "confidence": 0.5}]}'],
  ['confidence above 1', '{"is_transaction": true, "events": [{"kind": "sale", "confidence": 1.5}]}'],
  ['missing confidence', '{"is_transaction": true, "events": [{"kind": "sale"}]}'],
  ['amount as text', '{"is_transaction": true, "events": [{"kind": "sale", "amount_rupees": "40", "confidence": 0.5}]}'],
  ['no is_transaction', '{"events": []}'],
])('refused: %s', (_why, json) => {
  expect(() => parseExtraction(json, 'x', 'manual')).toThrow(ModelOutputInvalid);
});
