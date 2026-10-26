import { exchange, ProtocolError, type Hello, type Me, type Peer } from '../protocol';
import { EventStore, MemoryPersistence, type Have } from '../store';
import { handleSyncRpc, parsePeerAddress, parseSyncRpcResponse, SYNC_TCP_PORT, type RpcPushResponse, type SyncRpcResponse } from '../syncTcp';

function store(name = 'test-phone', randomSeed = 0.25) {
  let random = randomSeed;
  return EventStore.open(new MemoryPersistence(), name, {
    wall: () => 1_800_000_000,
    mono: () => 1,
    random: () => {
      random = (random + 0.137) % 1;
      return random;
    },
  });
}

describe('TCP sync address validation', () => {
  test.each([
    ['192.168.43.1', 'tcp://192.168.43.1:45871'],
    ['tcp://10.0.0.2:5000', 'tcp://10.0.0.2:5000'],
    ['172.31.255.254', 'tcp://172.31.255.254:45871'],
    ['169.254.1.2', 'tcp://169.254.1.2:45871'],
  ])('normalizes %s', (input, expected) => {
    expect(parsePeerAddress(input).url).toBe(expected);
  });

  test.each(['localhost', '8.8.8.8', '172.32.0.1', '192.168.1.256', '192.168.1.2:80', '192.168.1.2:65536'])(
    'rejects unsafe or invalid address %s',
    (input) => expect(() => parsePeerAddress(input)).toThrow(),
  );

  test('uses the documented sync port by default', () => {
    expect(parsePeerAddress('192.168.0.2').port).toBe(SYNC_TCP_PORT);
  });
});

describe('TCP sync RPC envelopes', () => {
  test('requires the family key for every request', () => {
    const response = handleSyncRpc(store(), 'instance-1', 'secret', { key: 'wrong', action: 'hello', me: null });
    expect(response).toEqual({ ok: false, error: 'family key did not match' });
  });

  test('answers hello for an authenticated peer', () => {
    const response = handleSyncRpc(store(), 'instance-1', 'secret', { key: 'secret', action: 'hello', me: null });
    expect(response).toMatchObject({
      ok: true,
      data: { protocol: 2, name: 'test-phone', instance: 'instance-1' },
    });
  });

  test('rejects malformed sync payloads rather than passing them to the ledger', () => {
    expect(handleSyncRpc(store(), 'instance-1', 'secret', {
      key: 'secret', action: 'pull', have: { actor: [[0, 2]] }, after: null, limit: 10,
    })).toEqual({ ok: false, error: 'pull have map is invalid' });
    expect(handleSyncRpc(store(), 'instance-1', 'secret', {
      key: 'secret', action: 'push', events: 'not-an-array',
    })).toEqual({ ok: false, error: 'push events must be a list of at most 2000 entries' });
  });

  test('validates the response frame envelope', () => {
    expect(parseSyncRpcResponse<{ value: number }>('{"ok":true,"data":{"value":7}}', 'tcp://192.168.0.2')).toEqual({ value: 7 });
    expect(() => parseSyncRpcResponse('not-json', 'tcp://192.168.0.2')).toThrow('sent invalid JSON');
    expect(() => parseSyncRpcResponse('{"ok":false,"error":"bad key"}', 'tcp://192.168.0.2')).toThrow('bad key');
  });

  test('authenticated RPC peer exchanges event pages in both directions', async () => {
    const local = store('local-phone', 0.2);
    const remote = store('remote-phone', 0.6);
    const localEvent = local.appendLocal('sale', 'manual', [
      { account: 'cash', amount: 1000 },
      { account: 'revenue:sales', amount: -1000 },
    ]);
    const remoteEvent = remote.appendLocal('sale', 'manual', [
      { account: 'cash', amount: 2500 },
      { account: 'revenue:sales', amount: -2500 },
    ]);
    const familyKey = 'shared-test-key';
    const request = (action: string, fields: Record<string, unknown>): unknown => {
      const wireRequest = JSON.parse(JSON.stringify({ key: familyKey, action, ...fields })) as unknown;
      const wireResponse = JSON.parse(JSON.stringify(handleSyncRpc(remote, 'remote-instance', familyKey, wireRequest))) as SyncRpcResponse;
      if (!wireResponse.ok) throw new ProtocolError(wireResponse.error);
      return wireResponse.data;
    };
    const peer: Peer = {
      url: 'tcp://192.168.0.2:45871',
      hello: async (me: Me | null) => request('hello', { me }) as Hello,
      pull: async (have: Have, after: [string, number] | null, limit: number) =>
        request('pull', { have, after, limit }) as { events: unknown[]; more: boolean },
      push: async (events: unknown[]) => request('push', { events }) as RpcPushResponse,
    };

    const report = await exchange(local, peer, 'local-instance', 1);
    expect(report).toMatchObject({ pulled: 1, pushed: 1, rejected: [] });
    expect(new Set(local.all().map((event) => event.id))).toEqual(new Set([localEvent.id, remoteEvent.id]));
    expect(new Set(remote.all().map((event) => event.id))).toEqual(new Set([localEvent.id, remoteEvent.id]));
  });
});
