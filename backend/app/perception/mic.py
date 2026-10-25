"""Always-on microphone: capture 16 kHz audio, cut it into utterances at pauses, hand them on.

Raw audio is never stored; only the transcript survives (privacy).

Controllable at runtime (main.py: /mic/start, /mic/stop, /mic/devices):
- The device is chosen by *name*, not index: indexes change when a headset is plugged in.
- Before opening a stream the audio system is re-scanned, so a headset plugged in after the backend
  started is found. (PortAudio otherwise keeps the device list from its first use, which is why a
  plugged-in earphone mic was never picked up.)
- A watchdog notices when the device stops delivering audio (unplugged, driver stall) and reopens
  it - falling back to the system default mic - instead of silently going deaf. Every reopen and
  error is counted and shown in the status.

Cutting uses a loudness gate that adapts to the room: a block counts as speech when it is louder than
max(MIN_THRESHOLD, NOISE_MULTIPLE x the running noise floor). Speech detection proper happens
afterwards: faster-whisper's bundled Silero VAD (vad_filter=True in asr.py) drops non-speech.
"""
import logging
import queue
import threading
import time
from collections.abc import Callable

import numpy as np

log = logging.getLogger("mic")

SAMPLE_RATE = 16_000
BLOCK = 512                 # ~32 ms
SILENCE_TO_CUT = 0.8        # seconds of quiet that ends an utterance
MAX_UTTERANCE = 20.0        # seconds
MIN_UTTERANCE = 0.3         # shorter bursts (a clap, a bang) are not sent to Whisper
NOISE_MULTIPLE = 3.0        # speech must be this many times louder than the room's noise floor
STALL_SECONDS = 3.0         # no audio blocks for this long = the device is gone
DEAD_LEVEL = 0.0002         # a working mic in a quiet room reads ~0.001; a muted one ~0.00002
DEAD_SECONDS = 5.0          # this long below DEAD_LEVEL = warn: muted in Windows, or the wrong mic
REOPEN_DELAY = 2.0
# One entry per physical mic: MME resamples to 16 kHz for us; the others list the same mic again
_HOST_API = "MME"
_NOT_MICS = ("sound mapper", "stereo mix", "speaker", "primary sound capture")


def _refresh_devices() -> None:
    """Make PortAudio re-scan the hardware (it caches the device list from its first use)."""
    import sounddevice as sd
    sd._terminate()
    sd._initialize()


def list_inputs(refresh: bool = True) -> list[dict]:
    import sounddevice as sd
    if refresh:
        _refresh_devices()
    try:
        default = sd.query_devices(kind="input")["name"]
    except Exception:
        default = None
    out = []
    for d in sd.query_devices():
        api = sd.query_hostapis(d["hostapi"])["name"]
        if d["max_input_channels"] < 1 or api != _HOST_API or any(w in d["name"].lower() for w in _NOT_MICS):
            continue
        out.append({"name": d["name"], "default": d["name"] == default})
    return out


def _resolve(name: str | None) -> tuple[int | None, str]:
    """Device name -> current index. None or a name that is gone -> the system default mic."""
    import sounddevice as sd
    if name:
        for i, d in enumerate(sd.query_devices()):
            if d["name"] == name and d["max_input_channels"] > 0 and sd.query_hostapis(d["hostapi"])["name"] == _HOST_API:
                return i, d["name"]
    return None, sd.query_devices(kind="input")["name"]


class MicListener:
    def __init__(self, on_utterance: Callable[[np.ndarray], None], device: str | int | None = None,
                 min_threshold: float = 0.01):
        self.on_utterance = on_utterance
        self.wanted = device if isinstance(device, str) else None   # an old numeric MIC_DEVICE_INDEX -> default
        self.min_threshold = min_threshold
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._work: queue.Queue[np.ndarray] = queue.Queue(maxsize=8)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self.listening = False
        self.device: str | None = None      # what is actually open right now
        self.state = "off"                  # off | opening | listening | reconnecting
        self.level = 0.0                    # recent loudness, for a live meter
        self.noise_floor = 0.0
        self.utterances = 0
        self.dropped = 0                    # utterances discarded because transcription fell behind
        self.reopens = 0
        self.errors = 0
        self.last_error: str | None = None
        self.last_heard_at: float | None = None
        self._dead_since: float | None = None   # when the level dropped to near-silence

    @property
    def running(self) -> bool:
        return any(t.is_alive() for t in self._threads)

    @property
    def status(self) -> dict:
        return {"listening": self.listening, "state": self.state, "device": self.device, "wanted": self.wanted,
                "level": round(self.level, 4), "threshold": round(self._threshold(), 4),
                "noise_floor": round(self.noise_floor, 4), "utterances": self.utterances, "dropped": self.dropped,
                "reopens": self.reopens, "errors": self.errors, "last_error": self.last_error,
                "warning": self._warning(),
                "seconds_since_heard": None if self.last_heard_at is None else round(time.monotonic() - self.last_heard_at, 1)}

    def start(self, device: str | None = None) -> None:
        """(Re)start listening, optionally on another device. Safe to call while running."""
        with self._lock:
            self.stop()
            if device is not None:
                self.wanted = device or None
            self._stop = threading.Event()
            self._threads = [threading.Thread(target=self._capture, args=(self._stop,), daemon=True, name="mic-capture"),
                             threading.Thread(target=self._handle, args=(self._stop,), daemon=True, name="mic-worker")]
            for t in self._threads:
                t.start()

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            if t is not threading.current_thread():
                t.join(timeout=3)
        self._threads = []
        self.listening, self.state, self.level = False, "off", 0.0

    def _warning(self) -> str | None:
        """A stream can be open yet deaf: Windows' mic mute (or a zero input level) delivers near-silence,
        which looks exactly like a quiet room to the gate. Say so instead of staying silently deaf."""
        if self.listening and self._dead_since is not None and time.monotonic() - self._dead_since > DEAD_SECONDS:
            return (f"'{self.device}' is giving almost no sound. Check that it is not muted in Windows "
                    "(Settings > System > Sound > Input), or pick another mic.")
        return None

    def _threshold(self) -> float:
        return max(self.min_threshold, NOISE_MULTIPLE * self.noise_floor)

    def _fail(self, msg: str) -> None:
        self.errors += 1
        self.last_error = msg
        log.error("mic: %s", msg)

    def _capture(self, stop: threading.Event) -> None:
        import sounddevice as sd

        while not stop.is_set():
            self.state = "opening" if self.reopens == 0 and self.errors == 0 else "reconnecting"
            try:
                _refresh_devices()
                index, name = _resolve(self.wanted)
                if self.wanted and name != self.wanted:
                    self._fail(f"'{self.wanted}' not found, using the default mic '{name}'")
                self._listen(sd, index, name, stop)
            except Exception as e:      # no device, driver error, stall: say so, then try again
                self._fail(f"{type(e).__name__}: {e}")
            finally:
                self.listening, self.level = False, 0.0
            if not stop.is_set():
                self.reopens += 1
                stop.wait(REOPEN_DELAY)
        self.state = "off"

    def _listen(self, sd, index: int | None, name: str, stop: threading.Event) -> None:
        while not self._q.empty():
            self._q.get_nowait()
        self._dead_since = None
        buf: list[np.ndarray] = []
        quiet = 0.0
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK, device=index,
                            callback=lambda data, *_: self._q.put(data[:, 0].copy())):
            self.listening, self.state, self.device = True, "listening", name
            log.info("mic: listening on %s", name)
            while not stop.is_set():
                try:
                    block = self._q.get(timeout=STALL_SECONDS)
                except queue.Empty:
                    raise RuntimeError(f"no audio from '{name}' for {STALL_SECONDS:g} s (unplugged?)") from None
                rms = float(np.sqrt(np.mean(block**2)))
                self.level = 0.7 * self.level + 0.3 * rms
                if self.level < DEAD_LEVEL:
                    self._dead_since = self._dead_since or time.monotonic()
                else:
                    self._dead_since = None
                speaking = rms > self._threshold()
                if not speaking:      # track the room's background level from quiet blocks only
                    self.noise_floor = rms if self.noise_floor == 0 else 0.98 * self.noise_floor + 0.02 * rms
                if speaking or buf:
                    buf.append(block)
                quiet = 0.0 if speaking else quiet + BLOCK / SAMPLE_RATE
                length = len(buf) * BLOCK / SAMPLE_RATE
                if buf and (quiet >= SILENCE_TO_CUT or length >= MAX_UTTERANCE):
                    if length - quiet >= MIN_UTTERANCE:
                        try:
                            self._work.put_nowait(np.concatenate(buf))
                            self.last_heard_at = time.monotonic()
                        except queue.Full:
                            self.dropped += 1
                    buf, quiet = [], 0.0

    def _handle(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                audio = self._work.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                self.on_utterance(audio)
                self.utterances += 1
            except Exception as e:  # one bad utterance must not kill the listener
                self._fail(f"utterance failed: {type(e).__name__}: {e}")
