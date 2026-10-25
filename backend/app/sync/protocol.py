"""The sync conversation between two devices, whatever carries the bytes (transport.py: HTTP on the LAN).

  hello -> {name, actor, have, instance}  who the peer is and which entries it holds (seq ranges per actor)
           The caller says who it is and may make this sync a shared moment (sync_id, mark): both
           phones then note it on their own monotonic clocks, and entries recorded in the next minute
           carry "N s after sync X" (Event.marks), so fusion can time two phones' entries exactly.
  pull  -> entries we lack, in (actor, seq) order, one page at a time, after a cursor
  push  -> entries the peer lacks (from its hello), one page at a time

Every step is idempotent and every page is saved as it arrives: a sync cut off half-way loses nothing,
and repeating it adds nothing. The cursor moves past entries the receiver refuses, so one bad entry can't
stall a sync; refusals are reported, never dropped silently. The same functions answer on the server side
(main.py's /sync/* endpoints), so both ends always speak the same protocol.
"""
import secrets
from typing import Protocol

from pydantic import ValidationError

from app.ledger.events import Event
from app.ledger.store import EventStore, Have

VERSION = 2
PAGE = 500          # entries per request: a phone away for days catches up in several small requests
MAX_PAGE = 2000
MARK_SPACING_S = 5.0        # at most one shared moment per peer every 5 s: ~12 marks per peer on an entry
LONG_MARK_SPACING_S = 60.0  # and one "long" moment a minute, kept 10 min (store.LONG_MARK_WINDOW_S): ~10 more


def new_instance() -> str:
    return secrets.token_hex(8)


INSTANCE = new_instance()     # this running process; tells "PEERS lists me myself" from "a copied ledger"


class Unreachable(Exception):
    """The peer could not be reached: out of range, switched off, or a wrong address."""


class PeerRefused(Exception):
    """The peer answered with an error (wrong sync key, a bad request...)."""


class ProtocolError(Exception):
    """The peer answered something this protocol doesn't allow, or the peer is this device itself."""


class Peer(Protocol):
    url: str

    def hello(self, me: dict | None) -> dict: ...

    def pull(self, have: Have, after: list | None, limit: int) -> dict: ...

    def push(self, events: list[dict]) -> dict: ...


# --- answering (server side) ----------------------------------------------------------------------
def hello(store: EventStore, me: dict | None = None, instance: str = INSTANCE) -> dict:
    """me = the caller: {name, actor, sync_id, mark, long}. mark=True: note this moment as shared with it."""
    if me and me.get("mark") and me.get("sync_id") and me.get("actor"):
        store.record_contact(me["actor"], me["sync_id"], long=bool(me.get("long")))
    return {"protocol": VERSION, "name": store.name, "actor": store.device_id, "instance": instance,
            "have": store.have(), "frontier": store.frontier()}


def pull(store: EventStore, have: Have, after: list | tuple | None, limit: int) -> dict:
    page, more = store.missing(have, tuple(after) if after else None, max(1, min(int(limit), MAX_PAGE)))
    return {"events": [e.model_dump(mode="json") for e in page], "more": more}


def parse(raw: list) -> tuple[list[Event], list[dict]]:
    """Entries from the wire -> (valid events, refusals). One malformed entry doesn't sink the page."""
    good, bad = [], []
    for item in raw:
        try:
            good.append(Event.model_validate(item))
        except ValidationError as e:
            err = e.errors()[0]
            bad.append({"id": item.get("id") if isinstance(item, dict) else None,
                        "reason": f"not a valid entry: {err['msg']} ({'.'.join(map(str, err['loc']))})"})
    return good, bad


def push(store: EventStore, events: list) -> dict:
    good, bad = parse(events)
    res = store.ingest(good)
    return {"added": res.added, "duplicates": res.duplicates, "rejected": bad + res.rejected,
            "rotated": res.rotated}


# --- asking (client side) -------------------------------------------------------------------------
def _cursor(page: list, before: tuple | None) -> tuple[str, int]:
    last = page[-1]
    if not isinstance(last, dict) or not isinstance(last.get("device_id"), str) or not isinstance(last.get("seq"), int):
        raise ProtocolError(f"a page ended with an entry that has no device_id/seq: {str(last)[:120]}")
    cur = (last["device_id"], last["seq"])
    if before is not None and cur <= before:
        raise ProtocolError(f"the peer's pages went backwards ({before} -> {cur})")
    return cur


def exchange(store: EventStore, peer: Peer, page: int = PAGE, known_actor: str | None = None) -> dict:
    """Pull what we lack, then push what the peer lacks. -> what happened (pulled, pushed, refusals...).
    known_actor: the peer's actor from the last exchange, to space shared moments MARK_SPACING_S apart."""
    age = store.contact_age(known_actor) if known_actor else None
    long_age = store.contact_age(known_actor, long=True) if known_actor else None
    mark = age is None or age >= MARK_SPACING_S
    long = mark and (long_age is None or long_age >= LONG_MARK_SPACING_S)
    sync_id = secrets.token_hex(6)
    t0 = store.mono()
    hi = peer.hello({"name": store.name, "actor": store.device_id, "sync_id": sync_id, "mark": mark, "long": long})
    t1 = store.mono()
    for key in ("name", "actor", "have"):
        if key not in hi:
            raise ProtocolError(f"{peer.url} said hello without {key!r}: is it running this app?")
    if hi.get("instance") == INSTANCE:
        raise ProtocolError(f"{peer.url} is this device itself: remove it from PEERS")
    if mark:                                   # the peer noted it while answering: the middle of our wait
        store.record_contact(hi["actor"], sync_id, at=(t0 + t1) / 2, long=long)
    rep = {"peer_name": hi["name"], "peer_actor": hi["actor"], "pulled": 0, "pushed": 0, "duplicates": 0,
           "rejected": [], "rotated": [], "warnings": []}
    if hi["name"] == store.name:
        rep["warnings"].append(f"{peer.url} is also called {store.name!r}: give every device its own DEVICE_ID "
                               f"(the books stay correct, but the two are hard to tell apart)")
    if hi["actor"] == store.device_id:
        rep["rotated"].append(store.rotate_actor(f"{peer.url} writes as {hi['actor']} too: a copied ledger file"))

    after = None
    while True:
        got = peer.pull(store.have(), list(after) if after else None, page)
        raw, more = got.get("events"), got.get("more")
        if not isinstance(raw, list) or not isinstance(more, bool):
            raise ProtocolError(f"{peer.url} answered a pull without events/more")
        if raw:
            good, bad = parse(raw)
            res = store.ingest(good)
            rep["pulled"] += res.added
            rep["duplicates"] += res.duplicates
            rep["rejected"] += bad + res.rejected
            if res.rotated:
                rep["rotated"].append(res.rotated)
            after = _cursor(raw, after)
        if not more:
            break
        if not raw:
            raise ProtocolError(f"{peer.url} said there is more but sent nothing")

    after = None
    while True:
        out, more = store.missing(hi["have"], after, page)
        if out:
            sent = peer.push([e.model_dump(mode="json") for e in out])
            if not isinstance(sent.get("added"), int):
                raise ProtocolError(f"{peer.url} answered a push without 'added'")
            rep["pushed"] += sent["added"]
            rep["rejected"] += [{**r, "at": "peer"} for r in sent.get("rejected") or []]
            if sent.get("rotated"):
                rep["rotated"].append({**sent["rotated"], "at": "peer"})
            after = (out[-1].device_id, out[-1].seq)
        if not more:
            break
    return rep
