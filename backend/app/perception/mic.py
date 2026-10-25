"""Always-on microphone: capture 16 kHz audio, cut it into utterances at pauses, hand them on.

Raw audio is never stored; only the transcript survives (privacy).

TODO(stage 2):
- replace the energy gate with faster_whisper's bundled Silero VAD for speech detection
- run in a background thread started from main.py when MIC_ENABLED=true
"""
import queue
import threading
from collections.abc import Callable

import numpy as np

SAMPLE_RATE = 16_000
BLOCK = 512                 # ~32 ms
SILENCE_TO_CUT = 0.8        # seconds of quiet that ends an utterance
MAX_UTTERANCE = 20.0        # seconds
ENERGY_THRESHOLD = 0.01     # placeholder until Silero VAD is wired in


class MicListener:
    def __init__(self, on_utterance: Callable[[np.ndarray], None], device_index: int | None = None):
        self.on_utterance = on_utterance
        self.device_index = device_index
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        import sounddevice as sd

        buf: list[np.ndarray] = []
        quiet = 0.0
        with sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK,
            device=self.device_index, callback=lambda data, *_: self._q.put(data[:, 0].copy()),
        ):
            while not self._stop.is_set():
                block = self._q.get()
                speaking = float(np.sqrt(np.mean(block**2))) > ENERGY_THRESHOLD
                if speaking or buf:
                    buf.append(block)
                quiet = 0.0 if speaking else quiet + BLOCK / SAMPLE_RATE
                length = len(buf) * BLOCK / SAMPLE_RATE
                if buf and (quiet >= SILENCE_TO_CUT or length >= MAX_UTTERANCE):
                    self.on_utterance(np.concatenate(buf))
                    buf, quiet = [], 0.0
