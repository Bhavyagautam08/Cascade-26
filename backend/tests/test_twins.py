"""Two phones hearing the same trade (fusion.py rules 3-5), timed by shared sync moments, never by wall
clocks. Each phone has its own monotonic clock that does not agree with the other's."""
import json
import time
from pathlib import Path

from app.ledger import fusion
from app.ledger.doubleentry import balances, postings_for
from app.ledger.events import Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore
from app.perception import rules

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))


class Phone:
    def __init__(self, tmp_path, name: str, clock: float):
        self.t = [clock]
        self.s = EventStore.open(tmp_path / f"{name}.db", name, mono=lambda: self.t[0])

    def at(self, clock: float) -> "Phone":
        self.t[0] = clock
        return self

    def say(self, text: str, source: Source = Source.voice):
        out = [self.s.append_local(c.kind, c.source, postings_for(c),
                                   payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                                   confidence=c.confidence, raw=c.raw)
               for c in rules.parse(text, LEX, source)]
        assert out, text
        return out[0] if len(out) == 1 else out

    def mark(self, *ids):
        return self.s.append_local(Kind.adjustment, Source.manual, [], payload={"same": sorted(ids)})

    def split(self, *ids):
        return self.s.append_local(Kind.adjustment, Source.manual, [], payload={"separate": sorted(ids)})


def meet(p: Phone, q: Phone, sync_id: str, long: bool = False):
    """A sync between p and q right now: both note the moment on their own clocks."""
    p.s.record_contact(q.s.device_id, sync_id, long=long)
    q.s.record_contact(p.s.device_id, sync_id, long=long)


def sync(*phones: Phone):
    for p in phones:
        for q in phones:
            if p is not q:
                p.s.ingest(q.s.all())


def books(p: Phone):
    rep = fuse(p.s.all())
    return rep, balances(rep.effective)


def same_everywhere(*phones: Phone):
    reps = [fuse(p.s.all()) for p in phones]
    first = reps[0]
    for r in reps[1:]:
        assert [e.id for e in r.effective] == [e.id for e in first.effective]
        assert (r.duplicates, r.conflicts, r.possible_duplicates) == (first.duplicates, first.conflicts,
                                                                       first.possible_duplicates)
    return first


def test_one_sale_heard_by_two_phones_counts_once(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 100.0), Phone(tmp_path, "phone-2", 5000.0)
    meet(a, b, "s1")
    x = a.at(103.0).say("7 plate poha de 140")
    y = b.at(5004.5).say("7 plate poha de 140")              # 1.5 s after x, by the shared moment
    sync(a, b)
    assert fusion.apart_s(x, y) == 1.5
    rep = same_everywhere(a, b)
    assert rep.duplicates == [[x.id, y.id]] and books(a)[1]["cash"] == 14000


def test_the_second_phone_may_already_hold_the_first_phones_entry(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 10.0), Phone(tmp_path, "phone-2", 70.0)
    meet(a, b, "s1")
    x = a.at(12.0).say("pandey ji ka 60 udhaar likh")
    sync(a, b)                                               # x reaches b before b's slower model finishes
    y = b.at(78.0).say("pandey ji ka 60 udhaar likh")
    sync(a, b)
    assert not fusion.concurrent(x, y)
    assert same_everywhere(a, b).duplicates == [[x.id, y.id]]
    assert books(b)[1]["receivable:pandey"] == 6000


def test_the_same_words_more_than_half_a_minute_apart_are_two_sales(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 100.0), Phone(tmp_path, "phone-2", 100.0)
    meet(a, b, "s1")
    a.at(102.0).say("7 plate poha de 140")
    b.at(102.0 + fusion.TWIN_S + 5).say("7 plate poha de 140")
    sync(a, b)
    rep, bal = books(a)
    assert rep.duplicates == [] and rep.possible_duplicates == [] and bal["cash"] == 28000


def test_in_contact_but_no_shared_moment_means_far_apart(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 100.0), Phone(tmp_path, "phone-2", 100.0)
    meet(a, b, "s1")
    a.at(101.0).say("7 plate poha de 140")
    sync(a, b)
    a.at(400.0)
    b.at(400.0)
    meet(a, b, "s2")
    b.at(401.0).say("7 plate poha de 140")                   # s1 has left b's window: no shared moment
    sync(a, b)
    rep, bal = books(a)
    assert rep.duplicates == [] and rep.possible_duplicates == [] and bal["cash"] == 28000


def test_one_utterance_heard_with_two_amounts_is_a_dispute(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 50.0), Phone(tmp_path, "phone-2", 900.0)
    meet(a, b, "s1")
    x = a.at(52.0).say("7 plate poha de 140")
    y = b.at(903.0).say("7 plate poha de 150")
    sync(a, b)
    rep = same_everywhere(a, b)
    (c,) = rep.conflicts
    assert c["ids"] == [x.id, y.id] and c["claims_paise"] == [14000, 15000]
    assert c["disputed_paise"] == 1000 and c["suspense_paise"] == 0 and c["item"] == "poha"
    assert books(a)[1]["cash"] == 14000                       # the lower claim is booked once


def test_udhaar_heard_with_two_amounts_waits_in_suspense(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    meet(a, b, "s1")
    a.at(1.0).say("sharma ji ka 40 jama")
    b.at(2.0).say("sharma ji ka 60 jama")                    # not a 40/400 pattern, but the same moment
    sync(a, b)
    rep, bal = books(a)
    assert rep.conflicts[0]["suspense_paise"] == 2000 and rep.possible_conflicts == []
    assert bal["cash"] == 4000 and bal["suspense"] == 2000


def test_out_of_contact_identical_entries_are_listed_and_a_person_decides(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)   # hotspot off: never synced
    x = a.at(5.0).say("7 plate poha de 140")
    y = b.at(6.0).say("7 plate poha de 140")
    sync(a, b)
    rep, bal = books(a)
    assert bal["cash"] == 28000                              # can't know: both count...
    (p,) = rep.possible_duplicates                           # ...and the pair is shown
    assert p["ids"] == [x.id, y.id] and p["amount_paise"] == 14000
    a.mark(x.id, y.id)                                       # "same sale"
    sync(a, b)
    rep, bal = books(b)
    assert bal["cash"] == 14000 and rep.possible_duplicates == [] and rep.duplicates == [[x.id, y.id]]
    b.split(x.id, y.id)                                      # changed their mind: the latest decision wins
    sync(a, b)
    rep, bal = books(a)
    assert bal["cash"] == 28000 and rep.possible_duplicates == [] and rep.duplicates == []


def test_two_identical_sales_heard_by_both_phones_pair_up_one_to_one(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    meet(a, b, "s1")
    a1 = a.at(1.0).say("7 plate poha de 140")
    b1 = b.at(2.0).say("7 plate poha de 140")
    a2 = a.at(25.0).say("7 plate poha de 140")               # a second customer, 24 s later
    b2 = b.at(26.5).say("7 plate poha de 140")
    sync(a, b)
    rep, bal = books(a)
    assert bal["cash"] == 28000
    assert sorted(rep.duplicates) == sorted([[a1.id, b1.id], [a2.id, b2.id]])


def test_one_order_of_two_items_pairs_by_item(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    meet(a, b, "s1")
    pa, ca = a.at(1.0).say("7 plate poha de 140 aur 5 cup chai de")
    cb, pb = b.at(1.5).say("5 cup chai de aur 7 plate poha de 140")
    sync(a, b)
    rep = same_everywhere(a, b)
    groups = {frozenset(g) for g in rep.duplicates}
    assert groups == {frozenset((pa.id, pb.id)), frozenset((ca.id, cb.id))}


def test_three_phones_hearing_one_sale_count_it_once(tmp_path):
    a, b, c = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0), Phone(tmp_path, "phone-3", 0.0)
    meet(a, b, "s1")
    meet(a, c, "s2")
    meet(b, c, "s3")
    xs = [p.at(t).say("7 plate poha de 140") for p, t in ((a, 1.0), (b, 2.0), (c, 3.5))]
    sync(a, b, c)
    rep = same_everywhere(a, b, c)
    assert [sorted(g) for g in rep.duplicates] == [sorted(x.id for x in xs)]
    assert books(c)[1]["cash"] == 14000


def test_a_payment_heard_on_one_phone_and_texted_to_the_other_counts_once(tmp_path):
    """The bank SMS lands on phone-2 minutes after phone-1 heard it; the phones synced in between."""
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    meet(a, b, "s1", long=True)
    x = a.at(10.0).say("sharma ji ka 40 jama")
    sync(a, b)
    y = b.at(160.0).say("sharma ji ka 40 jama", Source.sms)
    sync(a, b)
    assert not fusion.concurrent(x, y) and fusion.apart_s(x, y) == 150.0
    rep = same_everywhere(a, b)
    assert rep.duplicates == [[x.id, y.id]] and books(a)[1]["receivable:sharma"] == -4000


def test_the_same_amount_paid_again_later_counts_twice(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    meet(a, b, "s1", long=True)
    a.at(10.0).say("sharma ji ka 40 jama")
    sync(a, b)
    b.at(10.0 + fusion.CROSS_MODAL_S + 60).say("sharma ji ka 40 jama", Source.sms)
    sync(a, b)
    rep, bal = books(a)
    assert rep.duplicates == [] and bal["receivable:sharma"] == -8000


def test_a_mic_echo_needs_to_be_seconds_apart_on_the_same_run(tmp_path):
    a = Phone(tmp_path, "phone-1", 0.0)
    a.at(1.0).say("7 plate poha de 140")
    a.at(3.0).say("7 plate poha de 140")                     # cut twice by the mic: one sale
    assert books(a)[1]["cash"] == 14000
    a.at(200.0).say("7 plate poha de 140")                   # a quiet stall, the next customer
    assert books(a)[1]["cash"] == 28000


def test_human_decisions_need_matching_amounts(tmp_path):
    a = Phone(tmp_path, "phone-1", 0.0)
    x = a.at(1.0).say("7 plate poha de 140")
    y = a.at(500.0).say("7 plate poha de 150")
    a.mark(x.id, y.id)                                       # the API refuses this; fusion ignores it too
    assert books(a)[1]["cash"] == 29000


def test_fusion_stays_fast_on_a_busy_week(tmp_path):
    a, b = Phone(tmp_path, "phone-1", 0.0), Phone(tmp_path, "phone-2", 0.0)
    t = 0.0
    for i in range(700):                                     # ~100 trades a day for a week, heard by both
        t += 30
        meet(a.at(t), b.at(t), f"s{i}")                      # the engine syncs every few seconds; 30 s is sparse
        text = f"{1 + i % 9} plate poha de {20 * (1 + i % 9)}"
        a.at(t + 1).say(text)
        b.at(t + 2).say(text)
    sync(a, b)
    start = time.perf_counter()
    rep = fuse(a.s.all())
    took = time.perf_counter() - start
    assert len(rep.duplicates) == 700 and took < 2.0, took
