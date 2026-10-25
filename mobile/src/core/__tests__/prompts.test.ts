// The phone must ask the model exactly what the laptop asks (backend/app/perception/extractor.py).
import golden from '../__golden__/prompts.json';
import { Lexicon, type LexiconData } from '../lexicon';
import { EXTRACT_SCHEMA, extractSystem } from '../prompts.generated';

test('the system prompt (with the lexicon) is byte-for-byte the laptop’s', () => {
  const lex = new Lexicon(golden.lexicon as unknown as LexiconData, () => {});
  expect(extractSystem(lex.promptBlock())).toBe(golden.extract_system);
});

test('the JSON schema is the laptop’s', () => {
  expect(JSON.parse(EXTRACT_SCHEMA)).toEqual(golden.extract_schema);
});
