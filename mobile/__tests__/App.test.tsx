/**
 * The app's screens driven like a vendor would: tap, type, check that the ledger changed (not just the
 * screen). The phone-only pieces (SQLite, the model, the mic, sockets) are replaced by in-memory stand-ins;
 * everything from the screens down to the ledger is the real code.
 * @format
 */
import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

jest.mock('../src/app/sqlite', () => ({ SqlitePersistence: jest.requireActual('../src/core/store').MemoryPersistence }));
jest.mock('../src/app/files', () => ({
  files: { externalFilesDir: '/test', cacheDir: '/cache', fileSize: async () => -1, deleteFile: async () => true, writeWav: async (p: string) => p },
}));
jest.mock('../src/app/device', () => ({
  device: { startListening: async () => true, stopListening: async () => true, localAddresses: async () => [] },
}));
jest.mock('llama.rn', () => ({ initLlama: jest.fn(), getBackendDevicesInfo: jest.fn(async () => []) }));
jest.mock('whisper.rn', () => ({ initWhisper: jest.fn(), initWhisperVad: jest.fn() }), { virtual: true });
jest.mock('@fugood/react-native-audio-pcm-stream', () => ({ __esModule: true, default: { init: jest.fn(), start: jest.fn(), stop: jest.fn(), on: jest.fn() } }));
jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: { createServer: () => ({ on: jest.fn(), listen: jest.fn(), close: jest.fn() }), createConnection: jest.fn() },
}));
jest.mock('react-native-image-picker', () => ({ launchCamera: jest.fn(), launchImageLibrary: jest.fn() }));
jest.mock('@bam.tech/react-native-image-resizer', () => ({ __esModule: true, default: { createResizedImage: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

import App from '../App';
import { service } from '../src/app/service';
import { balances } from '../src/core/doubleentry';
import { fuse } from '../src/core/fusion';

jest.useFakeTimers();

let root: ReactTestInstance;
const isText = (n: ReactTestInstance) => (n.type as unknown) === 'Text'; // the host component under <Text>
const texts = () => root.findAll(isText).map((n) => [n.props.children].flat(5).join('')).join('\n');
const pressable = (label: string) => {
  const hits = root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  if (!hits.length) throw new Error(`nothing tappable called "${label}" on screen:\n${texts().slice(0, 1500)}`);
  return hits[0];
};
const press = async (label: string) => act(async () => pressable(label).props.onPress());
/** Tap whatever tappable thing holds this exact text (a list row). */
const pressText = async (text: string) => {
  let n: ReactTestInstance | null = root.find((x) => isText(x) && [x.props.children].flat(5).join('') === text);
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  if (!n) throw new Error(`"${text}" is not inside anything tappable`);
  await act(async () => n!.props.onPress());
};
const type = async (label: string, value: string) => {
  const input = root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function');
  await act(async () => input.props.onChangeText(value));
};
const counted = () => fuse(service.ledger!.store.all()).effective;
/** Alert.alert answers with the button whose text is `answer`. */
const answerAlerts = (answer: string) => jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.text === answer)?.onPress?.());

beforeAll(async () => {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(<App />);
  });
  root = r.root;
});

test('setup: the family key can be shown to check it, then the ledger opens', async () => {
  const secret = () => root.find((n) => n.props.accessibilityLabel === 'Parivaar ki chaabi (sab phones par same)' && 'secureTextEntry' in n.props);
  await type('Parivaar ki chaabi (sab phones par same)', 'ghar123');
  expect(secret().props.secureTextEntry).toBe(true);
  await press('Dikhao');
  expect(secret().props.secureTextEntry).toBe(false);
  await press('Shuru karein');
  expect(service.ledger).not.toBeNull();
  expect(service.syncKey()).toBe('ghar123');
});

test('start the day is one obvious button on Aaj', async () => {
  expect(texts()).toContain('Pehla din abhi shuru nahi hua');
  await press('Naya din shuru karo');
  expect(service.ledger!.summary().day.index).toBe(1);
  expect(texts()).toContain('Din 1 chal raha hai');
});

test('a doubtful entry is checked from Aaj: Sahi hai books it at full confidence', async () => {
  await act(async () => {
    await service.ledger!.handleText('2 kilo aloo liya 80', 'voice', { engine: 'rules', heardConfidence: 0.4 });
  });
  expect(texts()).toContain('Jaanch karein (1)');
  await press('Sahi hai');
  const live = counted().filter((e) => e.kind === 'purchase');
  expect(live).toHaveLength(1);
  expect(live[0].confidence).toBe(1);
  expect(texts()).toContain('Sab theek');
});

test('a wrong entry is removed from Aaj (after asking) and stops counting', async () => {
  await act(async () => {
    await service.ledger!.handleText('5 cup chai de', 'voice', { engine: 'rules', heardConfidence: 0.4 });
  });
  const spy = answerAlerts('Hatao');
  await press('Hatao');
  spy.mockRestore();
  expect(counted().some((e) => e.kind === 'sale')).toBe(false);
});

test('typed trade with a misspelt item: booked as the item, and the fix is shown', async () => {
  await press('Likho');
  await type('Kya hua', '3 kilo tamattar liya 180 mein');
  await press('Jodo');
  expect(texts()).toContain('“tamattar” ko “tamatar” samjha');
  expect(balances(counted())['inventory:tomato']).toBe(18000);
});

test('udhaar: write it, take part, then clear it from the customer page; the ledger follows', async () => {
  await press('Udhaar');
  await type('Grahak ka naam', 'Sharma ji');
  await type('Rakam ₹', '120');
  await press('Udhaar diya');
  expect(balances(counted())['receivable:sharma']).toBe(12000);

  await pressText('Sharma');
  expect(texts()).toContain('Is grahak ka hisaab');
  await type('Rakam ₹', '20');
  await press('Kuch paisa mila');
  expect(balances(counted())['receivable:sharma']).toBe(10000);

  const spy = answerAlerts('Haan');
  await press('Pura ₹100 mila · hisaab saaf');
  spy.mockRestore();
  expect(balances(counted())['receivable:sharma'] ?? 0).toBe(0);
});

test('stock: the morning list is read without the model and saved; a saved line can be removed', async () => {
  await press('Wapas');
  await press('Stock');
  await type('Subah / shaam ka stock', 'mere paas 5 kilo tamatar hain 200 rupaye ke');
  await press('Model se stock padhein');
  expect(texts()).toContain('Shabd-niyam se padha');
  await press('Jaanch kar hisaab mein jodein');
  const opening = counted().filter((e) => e.kind === 'opening_stock');
  expect(opening).toHaveLength(1);
  expect(opening[0].payload).toMatchObject({ item: 'tomato', qty: 5, inventory: 'opening' });

  const spy = answerAlerts('Hatao');
  await press('Hatao');
  spy.mockRestore();
  expect(counted().filter((e) => e.kind === 'opening_stock')).toHaveLength(0);
});
