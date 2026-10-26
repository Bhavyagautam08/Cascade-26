// The vendor-facing fixes: item spelling, stock read without the model, confirm/correct/withdraw a whole
// trade, udhaar payments, and the always-on mic's cutting into utterances.
import defaultLexicon from '../../data/lexicon.json';
import { balances } from '../doubleentry';
import { fuse } from '../fusion';
import { inventoryFromWords } from '../inventory';
import { AlreadyReplaced, Ledger } from '../ledger';
import { Lexicon, type LexiconData } from '../lexicon';
import { base64Bytes, rmsPcm16, Segmenter } from '../segmenter';
import { closestItem, fixItemSpelling, itemLabel, soundKey } from '../spelling';
import { EventStore, MemoryPersistence, type Clocks } from '../store';
import { hostsToScan } from '../syncTcp';

declare const Buffer: any; // jest runs in Node; the app's tsconfig has no Node types

const lex = JSON.parse(JSON.stringify(defaultLexicon)) as LexiconData;

function makeLedger() {
  let mono = 1;
  const clocks: Clocks = { wall: () => 1_750_000_000, mono: () => (mono += 0.5), random: () => 0.42 };
  const store = EventStore.open(new MemoryPersistence(), 'phone-1', clocks);
  return new Ledger(store, new Lexicon(JSON.parse(JSON.stringify(defaultLexicon)) as LexiconData, () => {}));
}
const counted = (L: Ledger) => fuse(L.store.all()).effective;

describe('item spelling', () => {
  test.each([
    ['tamattar', 'tamatar'],
    ['tamattax', 'tamatar'],
    ['Tamaatar', 'tamatar'],
    ['cheeni', 'cheeni'],
    ['chini', 'cheeni'],
    ['aaloo', 'aloo'],
    ['daal', 'dal'],
    ['dhania', 'dhaniya'],
    ['mirch', 'mirchi'],
    // read off the real grocery slip (eval/samples/slips/004) by Qwen on the phone
    ['tomattas', 'tamatar'],
    ['pyaza', 'pyaz'],
  ])('%s -> %s', (heard, shop) => expect(closestItem(heard, lex)).toBe(shop));

  test.each(['mila', 'bhai', 'bhaiya', 'maine', 'paisa', 'garmi', 'bahut', 'dalo', 'achha', 'kitna', 'chahiye', 'chalega', 'kharidna', 'dukaan', 'rupaye', 'sabzi', 'khatam', 'thoda', 'pakka', 'bilkul', 'zyada', 'kamaai', 'grahak', 'udhaari', 'samaan'])('common word %s is left alone', (w) => {
    expect(closestItem(w, lex)).toBeNull();
  });

  test('sound key collapses the usual Hinglish spelling swings', () => {
    expect(soundKey('tamattar')).toBe(soundKey('tamatar'));
    expect(soundKey('cheeni')).toBe('chini');
  });

  test('a sentence is fixed word by word and every change is listed', () => {
    const out = fixItemSpelling('3 kilo tamattar liya 180 mein, bhai', lex);
    expect(out.text).toBe('3 kilo tamatar liya 180 mein, bhai');
    expect(out.fixes).toEqual([{ from: 'tamattar', to: 'tamatar' }]);
  });

  test('the vendor sees their own word for a ledger item', () => {
    expect(itemLabel('tomato', lex)).toBe('tamatar');
    expect(itemLabel('poha', lex)).toBe('poha');
  });

  test('a typed trade with a misspelt item books the item and says so', async () => {
    const L = makeLedger();
    const r = await L.handleText('3 kilo tamattar liya 180 mein', 'manual', { engine: 'rules' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].payload).toMatchObject({ item: 'tomato', qty: 3, amount_rupees: 180 });
    expect(r.events[0].payload.flags).toContain('spelling:tamattar->tamatar');
    expect(r.normalized_text).toBe('3 kilo tamatar liya 180 mein');
    expect(balances(counted(L))['inventory:tomato']).toBe(18000);
  });
});

describe('stock by word rules (no model)', () => {
  test('morning: had vs bought, quantity, unit and cost from the words', () => {
    const items = inventoryFromWords('Mere paas 5 kilo tamatar hain 200 rupaye ke, do kilo aloo aaj liya 80 mein', lex, 'opening');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ item: 'tomato', qty: 5, unit: 'kg', total_cost: 200, status: 'opening', question: null });
    expect(items[1]).toMatchObject({ item: 'potato', qty: 2, unit: 'kg', total_cost: 80, status: 'purchased', question: null });
  });

  test('anything not said becomes a question, never a guess', () => {
    const [onion] = inventoryFromWords('pyaz bhi hai', lex, 'opening');
    expect(onion).toMatchObject({ item: 'onion', qty: null, question: 'onion kitna hai?' });
    const [milk] = inventoryFromWords('2 doodh', lex, 'opening');
    expect(milk.question).toContain('aaj kharida, ya pehle se tha?');
  });

  test('evening: what is left, "khatam" is zero', () => {
    const items = inventoryFromWords('2 kilo tamattar bacha hai, doodh khatam', lex, 'closing');
    expect(items[0]).toMatchObject({ item: 'tomato', qty: 2, unit: 'kg', status: 'closing', question: null });
    expect(items[1]).toMatchObject({ item: 'milk', qty: 0, question: null });
  });
});

describe('checking entries', () => {
  test('confirm keeps the facts and the words, at full confidence; the original stops counting', async () => {
    const L = makeLedger();
    const [e] = (await L.handleText('2 peti kanda liya 300', 'voice', { engine: 'rules', heardConfidence: 0.5 })).events;
    const [ok] = L.confirm(e.id);
    expect(ok.confidence).toBe(1);
    expect(ok.raw).toBe(e.raw);
    expect(ok.payload).toMatchObject({ item: e.payload.item, qty: e.payload.qty, amount_rupees: e.payload.amount_rupees });
    expect(ok.postings).toEqual(e.postings);
    expect(ok.payload.flags).toEqual(['confirmed']);
    expect(counted(L).map((x) => x.id)).toEqual([ok.id]);
  });

  test('correct changes only what the vendor changed and rebooks the money', async () => {
    const L = makeLedger();
    const [e] = (await L.handleText('3 kilo tamatar liya 180 mein', 'manual', { engine: 'rules' })).events;
    L.correct(e.id, { amount_rupees: 150 });
    const b = balances(counted(L));
    expect(b['inventory:tomato']).toBe(15000);
    expect(b.cash).toBe(-15000);
  });

  test('a stock count keeps its morning tag when corrected', async () => {
    const L = makeLedger();
    const e = L.store.appendLocal('opening_stock', 'manual', [], { payload: { item: 'tomato', qty: 5, unit: 'kg', amount_rupees: null, inventory: 'opening', recording_id: 'r1' }, confidence: 1 });
    const [c] = L.correct(e.id, { qty: 4 });
    expect(c.payload).toMatchObject({ item: 'tomato', qty: 4, inventory: 'opening', recording_id: 'r1' });
  });

  test('withdrawing one copy of a trade heard twice withdraws the trade', () => {
    const L = makeLedger();
    const [a] = L.record([{ kind: 'sale', source: 'voice', confidence: 0.8, item: 'tea', qty: 5, unit: 'plate', amount_rupees: 50, raw: '5 cup chai de' }]);
    const [b] = L.record([{ kind: 'sale', source: 'manual', confidence: 1, item: 'tea', qty: 5, unit: 'plate', amount_rupees: 50, raw: '5 cup chai' }]);
    expect(fuse(L.store.all()).duplicates).toEqual([[a.id, b.id].sort()]);
    expect(balances(counted(L)).cash).toBe(5000);
    const v = L.void(a.id);
    expect(v.supersedes.sort()).toEqual([a.id, b.id].sort());
    expect(balances(counted(L)).cash ?? 0).toBe(0);
    expect(() => L.void(b.id)).toThrow(AlreadyReplaced);
  });
});

describe('a sentence with no trade word', () => {
  test('is not booked, is flagged as maybe a trade, and the vendor can say what it was', async () => {
    const L = makeLedger();
    const heard = 'tomato 200 gram 40 rupee';
    expect((await L.handleText(heard, 'voice', { engine: 'rules' })).events).toHaveLength(0);
    expect(L.mightBeTrade(heard)).toBe(true);
    expect(L.mightBeTrade('aaj bahut garmi hai bhai')).toBe(false);
    const r = await L.bookAs(heard, 'sale', 'voice');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ kind: 'sale', payload: { item: 'tomato', qty: 0.2, unit: 'kg', amount_rupees: 40 } });
    expect(r.events[0].payload.flags).toContain('kind_from_vendor');
  });
});

describe('udhaar', () => {
  test('given, part paid, then cleared; history lists every step', () => {
    const L = makeLedger();
    L.udhaarGiven('Sharma ji', 120);
    L.udhaarPaid('sharma', 50);
    expect(balances(counted(L))['receivable:sharma']).toBe(7000);
    L.udhaarPaid('Sharma Ji', 70);
    expect(balances(counted(L))['receivable:sharma']).toBe(0);
    const h = L.udhaarHistory('sharma');
    expect(h.map((x) => [x.event.kind, x.paise])).toEqual([['credit_given', 12000], ['credit_paid', -5000], ['credit_paid', -7000]]);
  });

  test('one customer, however named; no customers ship with the app', async () => {
    const L = makeLedger();
    expect(L.lexicon.data.aliases).toEqual({});
    expect(['Sharma ji', 'sharma', 'Sharmaji', 'SHARMA  Uncle', 'sharma ji.'].map((n) => L.partyKey(n))).toEqual(['sharma', 'sharma', 'sharma', 'sharma', 'sharma']);
    expect(L.partyKey('Fauji')).toBe('fauji');
    expect(L.partyKey('bhai')).toBe('bhai');
    const [e] = (await L.handleText('sharma ji ka 60 udhaar likh', 'manual', { engine: 'rules' })).events;
    expect(e.payload.party).toBe('sharma');
    L.udhaarPaid('Sharma', 60);
    expect(balances(counted(L))['receivable:sharma'] ?? 0).toBe(0);
  });

  test('a wrong udhaar entry is withdrawn and the balance follows', () => {
    const L = makeLedger();
    const e = L.udhaarGiven('pandey', 60);
    L.void(e.id);
    expect(balances(counted(L))['receivable:pandey'] ?? 0).toBe(0);
    expect(L.udhaarHistory('pandey')[0].counts).toBe(false);
  });

  test('zero or a blank name is refused', () => {
    const L = makeLedger();
    expect(() => L.udhaarPaid('sharma', 0)).toThrow('more than');
    expect(() => L.udhaarGiven('  ', 10)).toThrow('empty');
  });
});

describe('finding family phones', () => {
  test('the hotspot or Wi-Fi /24 is scanned, minus this phone', () => {
    const hosts = hostsToScan([{ address: '192.168.43.17', prefix: 24 }]);
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe('192.168.43.1');
    expect(hosts).not.toContain('192.168.43.17');
    expect(hosts).not.toContain('192.168.43.255');
  });
  test('a bigger network is scanned only around this phone', () => {
    expect(hostsToScan([{ address: '10.0.5.9', prefix: 16 }])).toHaveLength(253);
    expect(hostsToScan([{ address: '10.0.5.9', prefix: 28 }])).toEqual(['10.0.5.1', '10.0.5.2', '10.0.5.3', '10.0.5.4', '10.0.5.5', '10.0.5.6', '10.0.5.7', '10.0.5.8', '10.0.5.10', '10.0.5.11', '10.0.5.12', '10.0.5.13', '10.0.5.14']);
  });
});

describe('always-on mic cutting', () => {
  const RATE = 16000;
  const block = (amp: number, n = 2048) => {
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 3)), 2 * i);
    return b.toString('base64');
  };

  test('base64 and loudness', () => {
    expect([...base64Bytes(Buffer.from([1, 2, 3, 4, 5]).toString('base64'))]).toEqual([1, 2, 3, 4, 5]);
    expect(rmsPcm16(base64Bytes(block(0)))).toBe(0);
    expect(rmsPcm16(base64Bytes(block(0.5)))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(() => base64Bytes('ab$d')).toThrow('not base64');
  });

  test('speech between pauses becomes one utterance, with a little audio before it', () => {
    const s = new Segmenter(RATE);
    const out = [];
    for (let i = 0; i < 20; i++) out.push(s.push(block(0.001))); // quiet room
    for (let i = 0; i < 10; i++) out.push(s.push(block(0.3))); // ~1.3 s of speech
    for (let i = 0; i < 8; i++) out.push(s.push(block(0.001))); // pause
    const utts = out.filter(Boolean);
    expect(utts).toHaveLength(1);
    expect(utts[0]!.chunks).toHaveLength(2 + 10 + 7); // pre-roll + speech + the pause until the cut
  });

  test('a short bang is not sent on; silence never is', () => {
    const s = new Segmenter(RATE);
    const out = [s.push(block(0.5)), ...Array.from({ length: 40 }, () => s.push(block(0)))];
    expect(out.filter(Boolean)).toHaveLength(0);
    expect(s.deadFor()).toBeGreaterThan(1);
  });

  test('a long monologue is cut at 20 s', () => {
    const s = new Segmenter(RATE);
    const out = Array.from({ length: 170 }, () => s.push(block(0.3)));
    expect(out.filter(Boolean)).toHaveLength(1);
  });
});
