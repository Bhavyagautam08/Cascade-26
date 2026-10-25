"""How sync messages travel: HTTP on the family's local Wi-Fi / hotspot. The conversation itself is in
protocol.py and doesn't care what carries it.

Every request carries the family's shared SYNC_KEY (X-Sync-Key), so other laptops on the hotspot can't
read or write the ledger. Failures are sorted for the status page: can't reach it (Unreachable), it said
no (PeerRefused), it said something we don't understand (ProtocolError).
"""
import httpx

from app.ledger.store import Have
from app.sync.protocol import PeerRefused, ProtocolError, Unreachable

SYNC_KEY_HEADER = "X-Sync-Key"
CONNECT_TIMEOUT_S = 2.0     # a phone that isn't on the hotspot costs at most this per round
READ_TIMEOUT_S = 20.0       # a page of entries from a slow phone


class LanPeer:
    """A peer is another device running this backend, reachable over the local network."""

    def __init__(self, url: str, sync_key: str = ""):
        self.url = url.rstrip("/")
        self._client = httpx.Client(timeout=httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
                                    headers={SYNC_KEY_HEADER: sync_key} if sync_key else {})

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        try:
            r = self._client.request(method, self.url + path, json=body)
        except httpx.TransportError as e:
            raise Unreachable(f"can't reach {self.url}: {type(e).__name__}: {e}") from e
        if r.status_code >= 400:
            raise PeerRefused(f"{r.status_code}: {r.text[:200]}")
        try:
            out = r.json()
        except ValueError as e:
            raise ProtocolError(f"{self.url}{path} did not answer JSON: {r.text[:120]!r}") from e
        if not isinstance(out, dict):
            raise ProtocolError(f"{self.url}{path} answered {type(out).__name__}, not an object")
        return out

    def hello(self, me: dict | None = None) -> dict:
        return self._call("POST", "/sync/hello", me or {})

    def pull(self, have: Have, after: list | None, limit: int) -> dict:
        return self._call("POST", "/sync/pull", {"have": have, "after": after, "limit": limit})

    def push(self, events: list[dict]) -> dict:
        return self._call("POST", "/sync/push", {"events": events})

    def close(self) -> None:
        self._client.close()
