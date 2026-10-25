"""How devices exchange events. Sync logic doesn't care whether bytes travel over LAN or Bluetooth.

Protocol (two messages, works over any transport):
  1. A sends its frontier {device_id: max_seq}
  2. B replies with every event A hasn't seen; A does the same in reverse
"""
from typing import Protocol

import httpx

from app.ledger.events import Event
from app.ledger.store import EventStore


class Transport(Protocol):
    def exchange(self, store: EventStore) -> int: ...


class LanTransport:
    """Peer is another device running this backend, reachable over local Wi-Fi."""

    def __init__(self, base_url: str):
        self.base_url = base_url

    def exchange(self, store: EventStore) -> int:
        with httpx.Client(timeout=5) as client:
            # pull what we're missing
            r = client.post(f"{self.base_url}/sync/pull", json={"frontier": store.frontier()})
            r.raise_for_status()
            added = store.ingest([Event.model_validate(e) for e in r.json()["events"]])
            # push what they're missing
            r = client.get(f"{self.base_url}/sync/frontier")
            r.raise_for_status()
            theirs = r.json()["frontier"]
            missing = [e.model_dump(mode="json") for e in store.missing_for(theirs)]
            client.post(f"{self.base_url}/sync/push", json={"events": missing}).raise_for_status()
        return added


# TODO(stage 6, stretch): BluetoothTransport using `bleak` with the same exchange() contract.
