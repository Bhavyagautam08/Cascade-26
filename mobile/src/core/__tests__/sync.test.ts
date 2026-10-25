// The sync conversation and engine on in-process phones whose messages cross as JSON (like the wire).
// Mirrors backend/tests/test_sync_engine.py.
import { balances } from '../doubleentry';
import { fuse } from '../fusion';
import { SyncEngine } from '../engine';
import { answerHello, answerPull, answerPush, exchange, Peer, ProtocolError, Unreachable } from '../protocol';
import { EventStore, MemoryPersistence } from '../store';

const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let seed = 1;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

class Phone {
  t = 0;
  db = new MemoryPersistence();
  s: EventStore;
  constructor(name: string, t = 0) {
    this.t = t;
    this.s = EventStore.open(this.db, name, { wall: () => 1_792_900_000, mono: () => this.t, random: rand });
  }
  sale(rupees = 10) {
    const a = rupees * 100;
    return this.s.appendLocal('sale', 'manual', [{ account: 'cash', amount: a }, { account: 'revenue:sales', amount: -a }]);
  }
}

class Wire implements Peer {
  reachable = true;
  instance = `inst-${Math.floor(rand() * 1e9)}`;
  url: string;
  constructor(readonly p: Phone) {
    this.url = `local://${p.s.name}`;
  }
  private check() {
    if (!this.reachable) throw new Unreachable(`${this.url} is out of range`);
  }
  async hello(me: any) {
    this.check();
    return wire(answerHello(this.p.s, this.instance, wire(me)));
  }
  async pull(have: any, after: any, limit: number) {
    this.check();
    return wire(answerPull(this.p.s, wire(have), wire(after), limit));
  }
  async push(events: unknown[]) {
    this.check();
    return wire(answerPush(this.p.s, wire(events)));
  }
}

const ids = (p: Phone) => new Set(p.s.all().map((e) => e.id));
const ME = 'this-phone';

test('one exchange moves everything both ways, in pages; repeating adds nothing', async () => {
  const a = new Phone('phone-1');
  const b = new Phone('phone-2');
  for (let i = 0; i < 5; i++) a.sale(10 + i);
  for (let i = 0; i < 3; i++) b.sale(50 + i);
  const rep = await exchange(a.s, new Wire(b), ME, 2);
  expect([rep.pulled, rep.pushed, rep.rejected]).toEqual([3, 5, []]);
  expect(ids(a)).toEqual(ids(b));
  const again = await exchange(a.s, new Wire(b), ME, 2);
  expect([again.pulled, again.pushed]).toEqual([0, 0]);
});

test('a cut-off exchange keeps what arrived and resumes', async () => {
  const a = new Phone('phone-1');
  const b = new Phone('phone-2');
  for (let i = 0; i < 6; i++) b.sale();
  const w = new Wire(b);
  const real = w.pull.bind(w);
  w.pull = async (...args) => {
    const out = await real(...args);
    w.reachable = false; // walks out of range after one page
    return out;
  };
  await expect(exchange(a.s, w, ME, 2)).rejects.toThrow(Unreachable);
  expect(a.s.all().length).toBe(2);
  w.pull = real;
  w.reachable = true;
  expect((await exchange(a.s, w, ME, 2)).pulled).toBe(4);
  expect(ids(a)).toEqual(ids(b));
});

test('a bad entry is refused alone, the rest arrives', async () => {
  const a = new Phone('phone-1');
  const b = new Phone('phone-2');
  const evs = [b.sale(), b.sale(), b.sale()];
  const w = new Wire(b);
  const real = w.pull.bind(w);
  w.pull = async (...args) => {
    const out = await real(...args);
    for (const e of out.events as any[]) if (e.id === evs[1].id) e.postings[0].amount += 1; // unbalanced
    return out;
  };
  const rep = await exchange(a.s, w, ME, 10);
  expect(rep.pulled).toBe(2);
  expect(rep.rejected.map((r) => r.id)).toEqual([evs[1].id]);
  expect(rep.rejected[0].reason).toMatch(/not a valid entry/);
});

test('a peer writing as our actor (a copied ledger) makes us switch before writing', async () => {
  const a = new Phone('phone-1');
  const twin = new Phone('phone-1');
  twin.db.meta = { ...a.db.meta };
  twin.s = EventStore.open(twin.db, 'phone-1', { wall: () => 0, mono: () => twin.t, random: rand });
  expect(twin.s.deviceId).toBe(a.s.deviceId);
  const old = a.s.deviceId;
  const rep = await exchange(a.s, new Wire(twin), ME);
  expect((rep.rotated[0] as any).from).toBe(old);
  expect(a.s.deviceId).not.toBe(old);
  expect(rep.warnings.join()).toMatch(/phone-1/);
  expect(a.sale().id).not.toBe(twin.sale().id);
});

test('this phone listed as its own peer is refused', async () => {
  const a = new Phone('phone-1');
  const me = new Wire(a);
  me.instance = ME;
  await expect(exchange(a.s, me, ME)).rejects.toThrow(ProtocolError);
});

test('a sync gives both phones the same moment, spaced 5 s apart', async () => {
  const a = new Phone('phone-1', 10);
  const b = new Phone('phone-2', 9000);
  await exchange(a.s, new Wire(b), ME);
  expect(a.s.contacts[b.s.deviceId].map((c) => c[0])).toEqual(b.s.contacts[a.s.deviceId].map((c) => c[0]));
  await exchange(a.s, new Wire(b), ME, 500, b.s.deviceId); // moments later: no new mark
  expect(a.s.contacts[b.s.deviceId].length).toBe(1);
  a.t += 5;
  b.t += 5;
  await exchange(a.s, new Wire(b), ME, 500, b.s.deviceId);
  expect(a.s.contacts[b.s.deviceId].length).toBe(2);
});

test('relay: a and c never meet, c still gets a’s entry through b', async () => {
  const [a, b, c] = [new Phone('phone-1'), new Phone('phone-2'), new Phone('phone-3')];
  const x = a.sale(40);
  await exchange(b.s, new Wire(a), ME);
  await exchange(c.s, new Wire(b), ME);
  expect(ids(c).has(x.id)).toBe(true);
});

test('engine: an absent phone is reported and catches up when it returns; books agree', async () => {
  const phones = [new Phone('phone-1'), new Phone('phone-2'), new Phone('phone-3')];
  const wires = phones.map((p) => new Wire(p));
  const engines = phones.map((p, i) => new SyncEngine(p.s, wires.filter((_, j) => j !== i), `inst-${i}`, 0));
  wires[1].reachable = false; // phone-2 goes to the mandi
  phones[0].sale(20);
  phones[1].sale(80);
  await engines[0].runOnce();
  const away = engines[0].status().peers.find((p) => p.url === wires[1].url)!;
  expect([away.state, away.failuresInARow]).toEqual(['unreachable', 1]);
  expect(away.lastError).toMatch(/out of range/);
  wires[1].reachable = true;
  for (let round = 0; round < 2; round++) for (const e of engines) await e.runOnce();
  const sets = phones.map(ids);
  expect(sets[0]).toEqual(sets[1]);
  expect(sets[1]).toEqual(sets[2]);
  const books = phones.map((p) => balances(fuse(p.s.all()).effective));
  expect(books[0]).toEqual(books[1]);
  expect(books[0].cash).toBe(10000);
  const back = engines[0].status().peers.find((p) => p.url === wires[1].url)!;
  expect([back.state, back.lastError, back.name]).toEqual(['ok', null, 'phone-2']);
});

test('engine: concurrent rounds share one round', async () => {
  const a = new Phone('phone-1');
  const b = new Phone('phone-2');
  const e = new SyncEngine(a.s, [new Wire(b)], 'x', 0);
  await Promise.all([e.runOnce(), e.runOnce(), e.runOnce()]);
  expect(e.rounds).toBe(1);
});
