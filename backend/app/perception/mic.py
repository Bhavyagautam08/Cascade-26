"""Always-on microphone: capture 16 kHz audio, cut it into utterances at pauses, hand them on.

Raw audio is never stored; only the transcript survives (privacy).

Started from main.py when MIC_ENABLED=true; each utterance goes to pipeline.handle_utterance on a worker
thread, so a slow transcription never stalls capture. Cutting uses a simple loudness gate that adapts to
the room: a block counts as speech when it is louder than max(MIN_THRESHOLD, NOISE_MULTIPLE x the running
noise floor). Speech detection proper happens afterwards: faster-whisper's bundled Silero VAD
(vad_filter=True in asr.py) drops non-speech inside each cut.

Status is honest: `listening` is true only while the audio stream is open, and errors (no mic, driver
failure, a crash while handling an utterance) are counted and kept for /health.
"""
import logging
import queue
import threading
from collections.abc import Callable

import numpy as np

log = logging.getLogger("mic")

SAMPLE_RATE = 16_000
BLOCK = 512                 # ~32 ms
SILENCE_TO_CUT = 0.8        # seconds of quiet that ends an utterance
MAX_UTTERANCE = 20.0        # seconds
MIN_UTTERANCE = 0.3         # shorter bursts (a clap, a bang) are not sent to Whisper
NOISE_MULTIPLE = 3.0        # speech must be this many times louder than the room's noise floor


class MicListener:
    def __init__(self, on_utterance: Callable[[np.ndarray], None], device_index: int | None = None,
                 min_threshold: float = 0.01):
        self.on_utterance = on_utterance
        self.device_index = device_index
        self.min_threshold = min_threshold
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._work: queue.Queue[np.ndarray] = queue.Queue(maxsize=8)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.listening = False
        self.noise_floor = 0.0
        self.utterances = 0
        self.dropped = 0          # utterances discarded because transcription fell behind
        self.errors = 0
        self.last_error: str | None = None

    @property
    def status(self) -> dict:
        return {"listening": self.listening, "utterances": self.utterances, "dropped": self.dropped,
                "errors": self.errors, "last_error": self.last_error,
                "threshold": round(self._threshold(), 4), "noise_floor": round(self.noise_floor, 4)}

    def start(self) -> None:
        self._threads = [threading.Thread(target=self._capture, daemon=True, name="mic-capture"),
                         threading.Thread(target=self._handle, daemon=True, name="mic-worker")]
        for t in self._threads:
            t.start()

    def stop(self) -> None:
        self._stop.set()

    def _threshold(self) -> float:
        return max(self.min_threshold, NOISE_MULTIPLE * self.noise_floor)

    def _fail(self, msg: str) -> None:
        self.errors += 1
        self.last_error = msg
        log.error("mic: %s", msg)

    def _capture(self) -> None:
        try:
            import sounddevice as sd

            buf: list[np.ndarray] = []
            quiet = 0.0
            with sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK,
                device=self.device_index, callback=lambda data, *_: self._q.put(data[:, 0].copy()),
            ):
                self.listening = True
                while not self._stop.is_set():
                    try:
                        block = self._q.get(timeout=1.0)
                    except queue.Empty:
                        continue
                    rms = float(np.sqrt(np.mean(block**2)))
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
                            except queue.Full:
                                self.dropped += 1
                        buf, quiet = [], 0.0
        except Exception as e:  # no device, driver error: the listener is dead, say so
            self._fail(f"capture stopped: {type(e).__name__}: {e}")
        finally:
            self.listening = False

    def _handle(self) -> None:
        while not self._stop.is_set():
            try:
                audio = self._work.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                self.on_utterance(audio)
                self.utterances += 1
            except Exception as e:  # one bad utterance must not kill the listener
                self._fail(f"utterance failed: {type(e).__name__}: {e}")
