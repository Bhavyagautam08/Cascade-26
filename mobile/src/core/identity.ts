// Who writes into a ledger. Ported from backend/app/ledger/identity.py.
//
// DEVICE name ("phone-1") is human. Each ledger writes as its own actor "<name>.<6 random letters>", chosen
// when the ledger is first opened and kept in it, so a ledger created again never reuses entry ids. If an
// entry under our own actor arrives that we don't hold (a copied / restored ledger), we switch to a fresh
// actor before writing again (store.ts).
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
export const SUFFIX_LEN = 6;
export const RESERVED = new Set(['fusion']); // fusion.ts's merged view uses it

export class IdentityError extends Error {}

export function checkName(name: string): string {
  if (!NAME_RE.test(name) || RESERVED.has(name)) {
    throw new IdentityError(
      `device name '${name}' can't be used: 1-32 letters, digits, '-' or '_' (no spaces, ':' or '.'), and not 'fusion'`,
    );
  }
  return name;
}

/** random: a source of uniform [0, 1) numbers (crypto-backed in the app, seeded in tests). */
export function newActor(name: string, random: () => number): string {
  let s = '';
  for (let i = 0; i < SUFFIX_LEN; i++) s += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)];
  return `${checkName(name)}.${s}`;
}

/** "phone-1.k3x9qa" -> "phone-1"; an id from before actors existed is its own name. */
export function nameOf(actor: string): string {
  return actor.split('.', 1)[0];
}
