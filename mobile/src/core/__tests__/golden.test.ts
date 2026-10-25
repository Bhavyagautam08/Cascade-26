// The TypeScript port must give the same answers as the Python code (scripts/make_golden.py wrote these).
import fusionCases from '../__golden__/fusion.json';
import rulesGolden from '../__golden__/rules.json';
import smsCases from '../__golden__/sms.json';
import { listDays } from '../days';
import { balances } from '../doubleentry';
import type { Event } from '../events';
import { fuse } from '../fusion';
import type { LexiconData } from '../lexicon';
import { parseDetailed, spokenNumbers } from '../rules';
import { parseSms } from '../sms';

const lex = rulesGolden.lexicon as unknown as LexiconData;

describe('rule parser = Python', () => {
  for (const c of rulesGolden.cases) {
    test(c.text, () => {
      const got = parseDetailed(c.text, lex);
      expect(got.events).toEqual(c.events);
      expect(got.unparsed).toEqual(c.unparsed);
      expect(spokenNumbers(c.text, lex)).toEqual(c.spoken);
    });
  }
});

describe('bank SMS parser = Python', () => {
  for (const c of smsCases) test(c.text, () => expect(parseSms(c.text)).toEqual(c.txn));
});

describe('fusion = Python', () => {
  for (const c of fusionCases) {
    test(c.name, () => {
      const events = c.events as unknown as Event[];
      const rep = fuse(events);
      expect(rep.effective.map((e) => ({ id: e.id, postings: e.postings }))).toEqual(c.effective.map((e) => ({ id: e.id, postings: e.postings })));
      rep.effective.forEach((e, i) => expect(e.confidence).toBeCloseTo(c.effective[i].confidence, 9));
      expect(rep.duplicates).toEqual(c.duplicates);
      expect(rep.conflicts).toEqual(c.conflicts);
      expect(rep.possible_conflicts).toEqual(c.possible_conflicts);
      expect(rep.possible_duplicates).toEqual(c.possible_duplicates);
      expect(balances(rep.effective)).toEqual(c.balances);
      expect(listDays(events)).toEqual(c.days);
    });
  }
});
