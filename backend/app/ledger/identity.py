"""Who writes into a ledger file.

Entry ids are `<actor>:<seq>`, and the family's books only stay one book if no two ledgers ever write the
same id. A DEVICE_ID alone can't promise that: a ledger file gets deleted and started again under the same
name (its counter restarts at 1), a .env is copied to a second laptop, a backup file is restored. So:

- DEVICE_ID is the human name ("phone-1"). The ledger file remembers it and refuses to open under another.
- Every ledger file writes as its own actor, `<name>.<6 random letters>` (e.g. "phone-1.k3x9qa"), chosen
  when the file is first opened and kept in the file. A ledger created again gets a new actor, so its new
  entries can never collide with the old ones that come back from the other phones.
- If an entry under our actor arrives that we don't hold, another file is writing as us (a copied or
  restored file): we keep the entry and switch to a fresh actor before writing again (store.ingest).
"""
import re
import secrets

NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")
SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # no 0/o, 1/l/i: readable when said aloud
SUFFIX_LEN = 6                                         # 31^6 ~ 890 million: two files of one name never meet
RESERVED = {"fusion"}                                  # fusion.py's merged view uses it


class IdentityError(RuntimeError):
    """The ledger file and DEVICE_ID don't belong together, or the name can't be used in ids."""


def check_name(name: str) -> str:
    if not NAME_RE.fullmatch(name) or name in RESERVED:
        raise IdentityError(f"DEVICE_ID {name!r} can't be used: 1-32 letters, digits, '-' or '_' "
                            f"(no spaces, ':' or '.'), and not {sorted(RESERVED)}")
    return name


def new_actor(name: str) -> str:
    return f"{check_name(name)}.{''.join(secrets.choice(SUFFIX_ALPHABET) for _ in range(SUFFIX_LEN))}"


def name_of(actor: str) -> str:
    """"phone-1.k3x9qa" -> "phone-1"; a plain id from before actors existed is its own name."""
    return actor.split(".", 1)[0]
