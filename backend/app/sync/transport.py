"""How devices exchange events. Sync logic doesn't care whether bytes travel over LAN or Bluetooth.

Protocol (two messages, works over any transport):
  1. A sends its frontier {device_id: highest seq held without gaps}
  2. B replies with every event A hasn't seen; A does the same in reverse
Every request carries the family's shared SYNC_KEY (X-Sync-Key), so other laptops on the hotspot can't
read or write the ledger.
"""
from typing import Protocol

import httpx

from app.ledger.events import Event
from app.ledger.store import EventStore

SYNC_KEY_HEADER = "X-Sync-Key"


class Transport(Protocol):
    def exchange(self, store: EventStore) -> dict: ...


class LanTransport:
    """Peer is another device running this backend, reachable over local Wi-Fi."""

    def __init__(self, base_url: str, sync_key: str = "", timeout: float = 5):
        self.base_url = base_url
        self.headers = {SYNC_KEY_HEADER: sync_key} if sync_key else {}
        self.timeout = timeout

    def exchange(self, store: EventStore) -> dict:
        """-> {"pulled": new events we received, "pushed": new events they accepted, "rejected": [...]}"""
        with httpx.Client(timeout=self.timeout, headers=self.headers) as client:
            r = client.post(f"{self.base_url}/sync/pull", json={"frontier": store.frontier()})
            r.raise_for_status()
            got = store.ingest([Event.model_validate(e) for e in r.json()["events"]])

            r = client.get(f"{self.base_url}/sync/frontier")
            r.raise_for_status()
            missing = [e.model_dump(mode="json") for e in store.missing_for(r.json()["frontier"])]
            r = client.post(f"{self.base_url}/sync/push", json={"events": missing})
            r.raise_for_status()
            sent = r.json()
        return {"pulled": got.added, "pushed": sent.get("added", 0),
                "rejected": got.rejected + sent.get("rejected", [])}


# TODO(stage 6, stretch): BluetoothTransport using `bleak` with the same exchange() contract.
