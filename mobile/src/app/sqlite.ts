// The ledger on the phone: one SQLite file with the same tables as the laptop's (store.py).
// Events are append-only; a batch is written in one transaction, so a crash mid-sync loses nothing.
import { open, type DB } from '@op-engineering/op-sqlite';
import type { Event } from '../core/events';
import type { Persistence } from '../core/store';

export class SqlitePersistence implements Persistence {
  private db: DB;

  constructor(name = 'ledger.sqlite') {
    this.db = open({ name });
    this.db.executeSync(
      'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE (device_id, seq))',
    );
    this.db.executeSync('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  loadEvents(): Event[] {
    return this.db.executeSync('SELECT body FROM events').rows.map((r) => JSON.parse(String(r.body)) as Event);
  }

  loadMeta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.executeSync('SELECT key, value FROM meta').rows) out[String(r.key)] = String(r.value);
    return out;
  }

  saveEvents(events: Event[]): void {
    this.db.executeSync('BEGIN TRANSACTION');
    try {
      for (const e of events) {
        this.db.executeSync('INSERT INTO events (id, device_id, seq, body) VALUES (?, ?, ?, ?)', [e.id, e.device_id, e.seq, JSON.stringify(e)]);
      }
      this.db.executeSync('COMMIT');
    } catch (err) {
      this.db.executeSync('ROLLBACK');
      throw err;
    }
  }

  /** Delete every entry and setting (the vendor starts over). The model files are not touched. */
  wipe(): void {
    this.db.executeSync('BEGIN TRANSACTION');
    try {
      this.db.executeSync('DELETE FROM events');
      this.db.executeSync('DELETE FROM meta');
      this.db.executeSync('COMMIT');
    } catch (err) {
      this.db.executeSync('ROLLBACK');
      throw err;
    }
  }

  setMeta(key: string, value: string): void {
    this.db.executeSync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }
}
