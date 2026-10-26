import {
  answerHello, answerPull, answerPush, MAX_PAGE, ProtocolError, type Me, type Peer, type Rejected,
} from './protocol';
import type { EventStore, Have } from './store';

export const SYNC_TCP_PORT = 45871;
export const SYNC_TCP_MAX_FRAME = 16 * 1024 * 1024;

export type PeerAddress = { host: string; port: number; url: string };
export type SyncRpcRequest = { key: string; action: string; [field: string]: unknown };
export type SyncRpcResponse = { ok: true; data: unknown } | { ok: false; error: string };

export function parsePeerAddress(input: string): PeerAddress {
  const value = input.trim().replace(/^tcp:\/\//i, '');
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(value);
  if (!match) throw new Error('peer address must be a local IPv4 address, optionally followed by :port');
  const octets = match[1].split('.').map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) throw new Error('peer IPv4 address has an invalid octet');
  const [first, second] = octets;
  const privateAddress = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
  if (!privateAddress) throw new Error('peer address must be on a private/local network (10/8, 172.16/12, 192.168/16, or link-local)');
  const port = match[2] ? Number(match[2]) : SYNC_TCP_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('peer port must be between 1024 and 65535');
  return { host: match[1], port, url: `tcp://${match[1]}:${port}` };
}

function isHave(value: unknown): value is Have {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 10_000
    && Object.values(value).every((ranges) => Array.isArray(ranges) && ranges.length <= 10_000
      && ranges.every((range) => Array.isArray(range) && range.length === 2
        && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[0] >= 1 && range[1] >= range[0]));
}

export function handleSyncRpc(store: EventStore, instance: string, familyKey: string, input: unknown): SyncRpcResponse {
  try {
    if (!familyKey) throw new ProtocolError('family key is not configured on this phone');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProtocolError('request must be an object');
    const request = input as Partial<SyncRpcRequest>;
    if (typeof request.key !== 'string' || request.key !== familyKey) throw new ProtocolError('family key did not match');
    if (typeof request.action !== 'string') throw new ProtocolError('request action is missing');
    let data: unknown;
    switch (request.action) {
      case 'hello': {
        const me = request.me;
        if (me !== null && (typeof me !== 'object' || Array.isArray(me)
          || ('name' in me && typeof me.name !== 'string')
          || ('actor' in me && typeof me.actor !== 'string')
          || ('sync_id' in me && typeof me.sync_id !== 'string')
          || ('mark' in me && typeof me.mark !== 'boolean')
          || ('long' in me && typeof me.long !== 'boolean'))) {
          throw new ProtocolError('hello peer data must contain valid fields');
        }
        data = answerHello(store, instance, (me ?? null) as Partial<Me> | null);
        break;
      }
      case 'pull': {
        if (!isHave(request.have)) throw new ProtocolError('pull have map is invalid');
        const after = request.after;
        if (after !== null && (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== 'string'
          || !Number.isInteger(after[1]) || Number(after[1]) < 1)) {
          throw new ProtocolError('pull cursor is invalid');
        }
        if (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > MAX_PAGE) {
          throw new ProtocolError(`pull page limit must be between 1 and ${MAX_PAGE}`);
        }
        data = answerPull(store, request.have, after as [string, number] | null, Number(request.limit));
        break;
      }
      case 'push': {
        if (!Array.isArray(request.events) || request.events.length > MAX_PAGE) {
          throw new ProtocolError(`push events must be a list of at most ${MAX_PAGE} entries`);
        }
        data = answerPush(store, request.events);
        break;
      }
      default:
        throw new ProtocolError(`unknown sync action: ${request.action}`);
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export type RpcPeer = Peer & { host: string; port: number };

export function parseSyncRpcResponse<T>(json: string, url: string): T {
  let response: SyncRpcResponse;
  try {
    response = JSON.parse(json) as SyncRpcResponse;
  } catch (error) {
    throw new ProtocolError(`${url} sent invalid JSON: ${(error as Error).message}`);
  }
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean'
    || (response.ok && !('data' in response)) || (!response.ok && typeof response.error !== 'string')) {
    throw new ProtocolError(`${url} sent an invalid response envelope`);
  }
  if (!response.ok) throw new ProtocolError(`${url}: ${response.error}`);
  return response.data as T;
}

export type RpcPushResponse = { added: number; duplicates: number; rejected: Rejected[]; rotated: unknown };

/** The hosts of this phone's own /24 (or smaller) networks, minus itself. */
export function hostsToScan(own: { address: string; prefix: number }[]): string[] {
  const out = new Set<string>();
  for (const { address, prefix } of own) {
    const p = Math.max(prefix, 24); // a bigger network is scanned only around this phone's own /24
    const ip = address.split('.').map(Number);
    const n = (((ip[0] << 24) >>> 0) + (ip[1] << 16) + (ip[2] << 8) + ip[3]) >>> 0;
    const mask = p === 32 ? 0xffffffff : (~((1 << (32 - p)) - 1)) >>> 0;
    const base = (n & mask) >>> 0;
    const size = 2 ** (32 - p);
    for (let i = 1; i < size - 1; i++) {
      const h = (base + i) >>> 0;
      if (h === n) continue;
      out.add([h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255].join('.'));
    }
  }
  return [...out];
}
