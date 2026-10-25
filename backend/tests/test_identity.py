"""Who writes into a ledger file. Two ledgers must never write entries under the same id: that would
fork the family's books forever (the same id, two contents). See app/ledger/identity.py."""
import re

import pytest

from app.ledger import identity
from app.ledger.events import Kind, Posting, Source
from app.ledger.store import EventStore

ACTOR = re.compile(r"phone-1\.[a-z2-9]{6}")


def _sale(store: EventStore, rupees: int = 10):
    amt = rupees * 100
    return store.append_local(Kind.sale, Source.manual,
                              [Posting(account="cash", amount=amt), Posting(account="revenue:sales", amount=-amt)])


def test_a_new_ledger_gets_its_own_actor_id_and_keeps_it(tmp_path):
    s = EventStore.open(tmp_path / "l.db", "phone-1")
    assert ACTOR.fullmatch(s.device_id) and s.name == "phone-1"
    assert _sale(s).id == f"{s.device_id}:1"
    actor = s.device_id
    s.db.close()
    again = EventStore.open(tmp_path / "l.db", "phone-1")
    assert again.device_id == actor and _sale(again).seq == 2


def test_a_reset_ledger_never_reuses_the_old_ids(tmp_path):
    """The vendor deletes the ledger file and starts again with the same DEVICE_ID."""
    old = EventStore.open(tmp_path / "old.db", "phone-1")
    peer = EventStore.open(tmp_path / "peer.db", "phone-2")
    peer.ingest([_sale(old, 10), _sale(old, 20)])
    fresh = EventStore.open(tmp_path / "fresh.db", "phone-1")
    assert fresh.device_id != old.device_id and fresh.name == "phone-1"
    res = peer.ingest([_sale(fresh, 99)])
    assert res.added == 1 and res.rejected == []
    assert fresh.ingest(peer.all()).rejected == []      # the old history comes back without a clash


def test_a_ledger_written_before_identities_gets_a_new_actor_and_keeps_its_entries(tmp_path):
    legacy = EventStore(tmp_path / "l.db", "phone-1")      # plain "phone-1" ids, no meta
    _sale(legacy)
    legacy.db.close()
    s = EventStore.open(tmp_path / "l.db", "phone-1")
    assert ACTOR.fullmatch(s.device_id)                    # can't prove the plain name was only ever this file's
    assert [e.id for e in s.all()] == ["phone-1:1"] and _sale(s).id == f"{s.device_id}:1"


def test_opening_someone_elses_ledger_is_refused(tmp_path):
    EventStore.open(tmp_path / "l.db", "phone-1").db.close()
    with pytest.raises(identity.IdentityError, match="phone-1.*phone-2"):
        EventStore.open(tmp_path / "l.db", "phone-2")


@pytest.mark.parametrize("bad", ["", "phone 1", "phone:1", "phone.1", "fusion", "x" * 33])
def test_device_names_that_would_break_ids_are_refused(tmp_path, bad):
    with pytest.raises(identity.IdentityError):
        EventStore.open(tmp_path / "l.db", bad)


def test_an_entry_under_our_own_id_from_elsewhere_makes_us_switch_ids(tmp_path):
    """A copied or restored ledger file: another ledger wrote under our actor id. We keep its entries
    (they are real family entries) and never write under that id again."""
    a = EventStore.open(tmp_path / "a.db", "phone-1")
    _sale(a)
    a.db.close()
    (tmp_path / "copy.db").write_bytes((tmp_path / "a.db").read_bytes())
    a, twin = EventStore.open(tmp_path / "a.db", "phone-1"), EventStore.open(tmp_path / "copy.db", "phone-1")
    assert a.device_id == twin.device_id                   # the copy is indistinguishable...
    from_twin = _sale(twin, 50)                            # ...until it writes
    res = a.ingest([from_twin])
    assert res.added == 1 and res.rotated["from"] == twin.device_id
    assert res.rotated["to"] != twin.device_id and a.device_id == res.rotated["to"]
    assert _sale(a, 70).id == f"{a.device_id}:1"           # fresh ids from here on
    assert identity.name_of(a.device_id) == "phone-1"
    a.db.close()
    assert EventStore.open(tmp_path / "a.db", "phone-1").device_id == res.rotated["to"]   # remembered


def test_a_clash_under_our_own_id_is_reported_and_we_switch_ids(tmp_path):
    a = EventStore.open(tmp_path / "a.db", "phone-1")
    a.db.close()
    (tmp_path / "copy.db").write_bytes((tmp_path / "a.db").read_bytes())
    a, twin = EventStore.open(tmp_path / "a.db", "phone-1"), EventStore.open(tmp_path / "copy.db", "phone-1")
    mine, theirs = _sale(a, 10), _sale(twin, 20)           # both wrote <actor>:1 with different content
    res = a.ingest([theirs])
    assert res.rejected == [{"id": theirs.id, "reason": "different content already stored under this id"}]
    assert res.rotated["from"] == mine.device_id and a.device_id != mine.device_id


def test_rotating_on_request_records_why(tmp_path):
    a = EventStore.open(tmp_path / "a.db", "phone-1")
    old = a.device_id
    rot = a.rotate_actor("a peer reports the same actor id")
    assert rot == {"from": old, "to": a.device_id, "because": "a peer reports the same actor id"}
    assert old in a.previous_actors()
