import TcpSocket from 'react-native-tcp-socket';
import { PeerRefused, ProtocolError, Unreachable, VERSION, type Hello, type Me, type Peer } from '../core/protocol';
import type { Have } from '../core/store';
import {
  handleSyncRpc, hostsToScan, parsePeerAddress, parseSyncRpcResponse, SYNC_TCP_MAX_FRAME, SYNC_TCP_PORT,
  type RpcPushResponse,
} from '../core/syncTcp';
import type { EventStore } from '../core/store';

const SOCKET_TIMEOUT_MS = 12_000;

export class TcpPeer implements Peer {
  readonly url: string;
  readonly host: string;
  readonly port: number;

  constructor(address: string, private readonly familyKey: string) {
    const parsed = parsePeerAddress(address);
    this.url = parsed.url;
    this.host = parsed.host;
    this.port = parsed.port;
  }

  hello(me: Me | null): Promise<Hello> {
    return this.request<Hello>('hello', { me }).then((hello) => {
      if (hello.protocol !== VERSION) throw new ProtocolError(`${this.url} uses sync protocol ${hello.protocol}; this app needs ${VERSION}`);
      return hello;
    });
  }

  pull(have: Have, after: [string, number] | null, limit: number): Promise<{ events: unknown[]; more: boolean }> {
    return this.request('pull', { have, after, limit });
  }

  push(events: unknown[]): Promise<RpcPushResponse> {
    return this.request('push', { events });
  }

  private request<T>(action: string, body: Record<string, unknown>): Promise<T> {
    if (!this.familyKey) return Promise.reject(new PeerRefused('family key is not configured on this phone'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let received = '';
      let socket: ReturnType<typeof TcpSocket.createConnection>;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket = TcpSocket.createConnection({ host: this.host, port: this.port, connectTimeout: SOCKET_TIMEOUT_MS }, () => {
        socket.setTimeout(SOCKET_TIMEOUT_MS);
        socket.write(`${JSON.stringify({ key: this.familyKey, action, ...body })}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (received.length > SYNC_TCP_MAX_FRAME) {
          finish(new ProtocolError(`${this.url} response exceeds the ${SYNC_TCP_MAX_FRAME} character limit`));
          return;
        }
        const newline = received.indexOf('\n');
        if (newline < 0) return;
        const extra = received.slice(newline + 1).trim();
        if (extra) {
          finish(new ProtocolError(`${this.url} sent more than one response frame`));
          return;
        }
        try {
          finish(undefined, parseSyncRpcResponse<T>(received.slice(0, newline), this.url));
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on('timeout', () => finish(new Unreachable(`${this.url} timed out`)));
      socket.on('error', (error) => finish(new Unreachable(`${this.url}: ${error.message}`)));
      socket.on('close', () => {
        if (!settled) finish(new Unreachable(`${this.url} closed before replying`));
      });
    });
  }
}

export type SyncServerState = 'starting' | 'listening' | 'error' | 'stopped';

export class LocalSyncServer {
  private server: ReturnType<typeof TcpSocket.createServer> | null = null;

  constructor(
    private readonly store: EventStore,
    private readonly instance: string,
    private readonly getFamilyKey: () => string,
    private readonly onState: (state: SyncServerState, error: string | null) => void,
  ) {}

  start() {
    if (this.server) return;
    this.onState('starting', null);
    const server = TcpSocket.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      let frame = '';
      let handled = false;
      const reply = (response: unknown) => {
        if (handled) return;
        handled = true;
        socket.end(`${JSON.stringify(response)}\n`);
      };
      socket.on('data', (chunk) => {
        if (handled) return;
        frame += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (frame.length > SYNC_TCP_MAX_FRAME) {
          reply({ ok: false, error: `request exceeds the ${SYNC_TCP_MAX_FRAME} character limit` });
          return;
        }
        const newline = frame.indexOf('\n');
        if (newline < 0) return;
        if (frame.slice(newline + 1).trim()) {
          reply({ ok: false, error: 'send one request per connection' });
          return;
        }
        try {
          const request = JSON.parse(frame.slice(0, newline)) as unknown;
          reply(handleSyncRpc(this.store, this.instance, this.getFamilyKey(), request));
        } catch (error) {
          reply({ ok: false, error: `invalid request: ${(error as Error).message}` });
        }
      });
      socket.on('timeout', () => reply({ ok: false, error: 'request timed out' }));
      socket.on('error', (error) => {
        if (!handled) reply({ ok: false, error: error.message });
      });
    });
    this.server = server;
    server.on('listening', () => this.onState('listening', null));
    server.on('error', (error) => this.onState('error', error.message));
    server.on('close', () => {
      this.server = null;
      this.onState('stopped', null);
    });
    server.listen({ host: '0.0.0.0', port: SYNC_TCP_PORT, reuseAddress: true });
  }

  stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.close((error) => {
      if (error) this.onState('error', error.message);
      else this.onState('stopped', null);
    });
  }
}

export const syncPort = SYNC_TCP_PORT;

// --- finding family phones without typing addresses ---------------------------------------------------
// Every phone runs the sync server on the same port. Finding the others = asking each address on this
// phone's own network (Wi-Fi or its hotspot) "hello" with a short timeout. No internet, no cloud, nothing
// broadcast but this hello; a phone answers only with its name, and only to the right family key.
export type Found = { url: string; host: string; name: string; actor: string; keyOk: boolean };

const PROBE_TIMEOUT_MS = 900;
const PROBE_PARALLEL = 48;

/** Ask one address for hello. A Hisaab phone answers (right or wrong key); anything else -> null. */
export function probe(host: string, familyKey: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Found | null> {
  const url = `tcp://${host}:${SYNC_TCP_PORT}`;
  return new Promise((resolve) => {
    let done = false;
    let received = '';
    const finish = (v: Found | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const socket = TcpSocket.createConnection({ host, port: SYNC_TCP_PORT, connectTimeout: timeoutMs }, () => {
      socket.write(`${JSON.stringify({ key: familyKey, action: 'hello', me: null })}\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = received.indexOf('\n');
      if (nl < 0) return;
      try {
        const r = JSON.parse(received.slice(0, nl)) as { ok: boolean; data?: Hello; error?: string };
        if (r.ok && r.data) finish({ url, host, name: r.data.name, actor: r.data.actor, keyOk: true });
        else if (r.error && /family key/.test(r.error)) finish({ url, host, name: '?', actor: '', keyOk: false });
        else finish(null);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/** Ask every address on this phone's networks; reports progress as it goes. */
export async function discover(own: { address: string; prefix: number }[], familyKey: string, onProgress: (done: number, total: number, found: Found[]) => void): Promise<Found[]> {
  const hosts = hostsToScan(own);
  const found: Found[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++];
      const f = await probe(host, familyKey);
      done++;
      if (f) found.push(f);
      if (f || done % 16 === 0 || done === hosts.length) onProgress(done, hosts.length, [...found]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, hosts.length) }, worker));
  return found;
}
