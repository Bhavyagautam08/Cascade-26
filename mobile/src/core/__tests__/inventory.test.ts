import { confirmInventory, InventoryNeedsAnswers, InventoryWouldOverwrite, inventoryPrompt, inventoryRecordingId, parseInventoryAnswer, todayInventory, type InventoryItem } from '../inventory';
import { Ledger } from '../ledger';
import { Lexicon, type LexiconData } from '../lexicon';
import { EventStore, MemoryPersistence, type Clocks } from '../store';

const lexicon: LexiconData = {
  items: { tamatar: 'tomato', pyaz: 'onion', doodh: 'milk' },
  units: {
    kg: { unit: 'kg', factor: 1 }, kilo: { unit: 'kg', factor: 1 },
    g: { unit: 'kg', factor: 0.001 }, gram: { unit: 'kg', factor: 0.001 },
    l: { unit: 'l', factor: 1 }, litre: { unit: 'l', factor: 1 },
  },
  numbers: { ek: 1, do: 2, teen: 3, sau: 100 },
};
const clocks: Clocks = { wall: () => 1_750_000_000, mono: () => 1, random: () => 0.123456 };
const item = (changes: Partial<InventoryItem> = {}): InventoryItem => ({
  item: 'tomato', said: 'mere paas 5 kilo tamatar hain', qty: 5, unit: 'kg', total_cost: 200,
  unit_cost: 40, status: 'opening', confidence: 1, flags: [], question: null, ...changes,
});
function makeLedger() {
  const store = EventStore.open(new MemoryPersistence(), 'test-phone', clocks);
  const lex = new Lexicon(lexicon, () => {});
  return new Ledger(store, lex);
}

test('inventory prompt carries the selected mode and the lexicon with Python-compatible JSON', () => {
  expect(inventoryPrompt(lexicon, 'opening')).toContain('Lexicon: {"items": {"tamatar": "tomato"');
  expect(inventoryPrompt(lexicon, 'closing')).toContain('At the end of the day');
});

test('only quantities and prices present in the words survive; held-or-bought comes from the words', () => {
  const transcript = 'mere paas 3 kilo pyaz hai 90 rupaye ka, aur aloo tamatar hain';
  const answer = JSON.stringify({ items: [
    { said: '3 kilo pyaz hai 90 rupaye ka', item: 'onion', qty: 3, unit: 'kilo', total_cost: 90, status: 'purchased' },
    { said: 'tamatar hain', item: 'tomato', qty: 5, unit: 'kg', total_cost: 200, status: 'opening' },
  ] });
  const parsed = parseInventoryAnswer(answer, transcript, lexicon, 'opening');
  expect(parsed[0]).toMatchObject({ item: 'onion', qty: 3, unit: 'kg', total_cost: 90, status: 'opening', flags: ['status_from_words:purchased->opening'] });
  expect(parsed[1]).toMatchObject({ qty: null, total_cost: null, status: 'opening', question: 'How much tomato is there?', flags: ['quantity_not_heard:5', 'cost_not_heard:200', 'cost_missing'] });
});

test('uses one explicitly marked price from an item description but does not select an ambiguous one', () => {
  const one = parseInventoryAnswer(JSON.stringify({ items: [
    { said: 'mere paas 5 kilo tamatar hain 200 rupaye ke khareede the', item: 'tomato', qty: 5, unit: 'kilo', total_cost: null, status: 'purchased' },
  ] }), 'mere paas 5 kilo tamatar hain 200 rupaye ke khareede the', lexicon, 'opening');
  expect(one[0]).toMatchObject({ total_cost: 200, status: 'opening', unit_cost: 40 });

  const ambiguous = parseInventoryAnswer(JSON.stringify({ items: [
    { said: 'tamatar 5 kilo 200 rupaye, aloo 80 rupaye', item: 'tomato', qty: 5, unit: 'kilo', total_cost: null, status: 'opening' },
  ] }), 'tamatar 5 kilo 200 rupaye, aloo 80 rupaye', lexicon, 'opening');
  expect(ambiguous[0]).toMatchObject({ total_cost: null, question: expect.stringContaining('Did you buy') });
});

test('closing mode treats khatam as zero and asks for every missing count or unit', () => {
  const parsed = parseInventoryAnswer(JSON.stringify({ items: [
    { said: 'doodh khatam', item: 'milk', qty: 0, unit: null, total_cost: null, status: 'opening' },
    { said: 'mirchi thodi si hai', item: 'chilli', qty: null, unit: null, total_cost: null, status: 'opening' },
  ] }), 'shaam doodh khatam, mirchi thodi si hai', lexicon, 'closing');
  expect(parsed[0]).toMatchObject({ qty: 0, status: 'closing', question: null });
  expect(parsed[1]).toMatchObject({ status: 'closing', question: 'How much chilli is there?' });
});

test('rejects malformed model output rather than guessing fields', () => {
  expect(() => parseInventoryAnswer('no json', 'text', lexicon, 'opening')).toThrow();
  expect(() => parseInventoryAnswer('{"items":[{"said":"x","item":"x","qty":-1,"unit":"kg","total_cost":0,"status":"opening"}]}', 'x', lexicon, 'opening')).toThrow();
});

test('recording IDs match the server format and distinguish morning from evening', () => {
  expect(inventoryRecordingId(' Hello ', 'opening')).toBe('opening:2cf24dba5fb0a30e26e83b2a');
  expect(inventoryRecordingId('hello', 'closing')).toBe('closing:2cf24dba5fb0a30e26e83b2a');
  expect(inventoryRecordingId('HELLO', 'opening')).toBe(inventoryRecordingId('hello', 'opening'));
});

test('confirmation records opening stock, purchase/order and evening counts, with dedup and guarded replacement', () => {
  const ledger = makeLedger();
  const openId = inventoryRecordingId('morning list', 'opening');
  const first = confirmInventory(ledger, openId, 'morning list', [
    item(),
    item({ item: 'milk', status: 'purchased', qty: 2, unit: 'l', total_cost: 120, unit_cost: 60 }),
    item({ item: 'bread', status: 'purchased', qty: 1, unit: 'packet', total_cost: null, unit_cost: null }),
  ], 'opening');
  expect(first.events.map((event) => event.kind)).toEqual(['opening_stock', 'purchase', 'order']);
  expect(first.events[0].postings.map((posting) => posting.account)).toContain('equity:opening_stock');
  expect(confirmInventory(ledger, openId, 'morning list', [item()], 'opening').duplicate).toBe(true);

  expect(() => confirmInventory(ledger, inventoryRecordingId('replacement', 'opening'), 'replacement', [
    item({ qty: 6 }),
  ], 'opening')).toThrow(InventoryWouldOverwrite);
  const replaced = confirmInventory(ledger, inventoryRecordingId('replacement', 'opening'), 'replacement', [
    item({ qty: 6 }),
  ], 'opening', true);
  expect(replaced.replaced).toEqual([first.events[0].id]);
  expect(ledger.store.all()).toHaveLength(4);
  expect(todayInventory(ledger.store.all(), 'opening')).toHaveLength(3);

  const closing = confirmInventory(ledger, inventoryRecordingId('evening list', 'closing'), 'evening list', [
    item({ qty: 2, unit: 'kg', total_cost: null, status: 'closing', question: null }),
  ], 'closing');
  expect(closing.events[0]).toMatchObject({ kind: 'stock_count', postings: [], payload: { closing: true, inventory: 'closing' } });
  expect(todayInventory(ledger.store.all(), 'closing')).toHaveLength(1);
});

test('blocks unanswered questions and empty confirmation without writing events', () => {
  const ledger = makeLedger();
  expect(() => confirmInventory(ledger, 'id', 'text', [item({ status: 'unclear', question: 'answer me' })], 'opening')).toThrow(InventoryNeedsAnswers);
  expect(() => confirmInventory(ledger, 'id', 'text', [], 'opening')).toThrow(InventoryNeedsAnswers);
  expect(ledger.store.all()).toHaveLength(0);
});
