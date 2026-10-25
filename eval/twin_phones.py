"""Can the WORDS tell one utterance heard by two phones from two different utterances? (Measured: no.)

words_alike() below is the measure that was tried for spotting one trade heard by two phones. Result on
the real clips (eval/reports/2026-10-26_014456_twins.md): the same utterance on a degraded second phone
scored 0.00-0.78, different utterances up to 0.28, so no threshold separates them. fusion.py uses the
time between entries measured against shared sync moments instead (Event.marks).

Each real clip in eval/samples/audio is transcribed as heard by this phone (the clip) and as a second phone
would hear it: quieter, noisier, muffled, or catching only the second part. Every variant goes through the
app's own Whisper setup (model, language, lexicon hotwords). Writes eval/reports/<timestamp>_twins.md.

    cd backend
    uv run python ../eval/twin_phones.py

The simulated second phone is an approximation of a real one (no room echo, no second speaker); the
report says so. Fixed noise seed, so a rerun hears the same noise.
"""
import datetime as dt
import itertools
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "backend"))

from app.config import settings  # noqa: E402
from app.perception.asr import ASR, _decode_wav  # noqa: E402
from app.perception.lexicon import Lexicon  # noqa: E402

SR = 16_000
rng = np.random.default_rng(7)


def words_alike(a: str | None, b: str | None) -> float:
    """How much of the shorter text the longer one also says, in order (0..1): containment, because one
    phone may catch only part of an utterance. Under 2 words: equal or not."""
    wa, wb = (re.findall(r"[a-z0-9]+", (t or "").lower()) for t in (a, b))
    if min(len(wa), len(wb)) < 2:
        return float(bool(wa) and wa == wb)
    matched = sum(m.size for m in SequenceMatcher(None, wa, wb, autojunk=False).get_matching_blocks())
    return matched / min(len(wa), len(wb))


def noise_at(x: np.ndarray, snr_db: float) -> np.ndarray:
    p = float(np.mean(x ** 2)) or 1e-12
    return x + rng.normal(0, np.sqrt(p / 10 ** (snr_db / 10)), x.shape).astype(np.float32)


def muffle(x: np.ndarray, taps: int = 9) -> np.ndarray:            # a cheap phone mic: high frequencies lost
    return np.convolve(x, np.ones(taps, dtype=np.float32) / taps, mode="same")


VARIANTS = {
    "far (-12 dB, SNR 15)": lambda x: noise_at(x * 0.25, 15),
    "noisy (SNR 5)": lambda x: noise_at(x * 0.5, 5),
    "muffled (SNR 10)": lambda x: noise_at(muffle(x), 10),
    "second half only (SNR 15)": lambda x: noise_at(x[len(x) // 2:], 15),
}


def main() -> int:
    clips = sorted((ROOT / "samples" / "audio").glob("*.wav"))
    if len(clips) < 2:
        print("need at least 2 clips in eval/samples/audio", file=sys.stderr)
        return 1
    asr = ASR(settings.whisper_ref(settings.whisper_model), settings.whisper_device, settings.whisper_compute_type,
              settings.whisper_language)
    hot = Lexicon(settings.resolve(settings.lexicon_path)).hotwords()
    heard: dict[str, dict[str, str]] = {}
    for c in clips:
        x = _decode_wav(c.read_bytes())
        heard[c.stem] = {}
        for name, fn in {"this phone (clip)": lambda v: v, **VARIANTS}.items():
            t = asr.transcribe(fn(x).astype(np.float32), hotwords=hot)
            heard[c.stem][name] = t.text if t else ""
            print(f"{c.stem} | {name}: {heard[c.stem][name]}")

    same = [(clip, v, words_alike(h["this phone (clip)"], h[v])) for clip, h in heard.items() for v in VARIANTS]
    diff = [(a, b, va, vb, words_alike(heard[a][va], heard[b][vb]))
            for a, b in itertools.combinations(heard, 2) for va in heard[a] for vb in heard[b]]
    lo_same, hi_diff = min(s for *_, s in same), max(s for *_, s in diff)

    lines = [f"# Two phones, one utterance ({dt.datetime.now():%Y-%m-%d %H:%M})", "",
             f"ASR `{asr.name}`, hotwords from the lexicon, noise seed 7. Simulated second phone: gain, white "
             "noise, a moving-average low-pass, or only the second half of the clip. No room echo, no second "
             "speaker: a real second phone can be worse.", "", "## Transcripts", ""]
    for clip, h in heard.items():
        lines += [f"**{clip}**", ""] + [f"- {v}: `{t}`" for v, t in h.items()] + [""]
    lines += ["## Same utterance, two phones: words_alike", "", "| clip | second phone | alike |", "|---|---|---|"]
    lines += [f"| {c} | {v} | {s:.2f} |" for c, v, s in same]
    lines += ["", "## Different utterances: words_alike (highest 10)", "", "| a | b | alike |", "|---|---|---|"]
    lines += [f"| {a} ({va}) | {b} ({vb}) | {s:.2f} |" for a, b, va, vb, s in sorted(diff, key=lambda r: -r[-1])[:10]]
    lines += ["", f"**Lowest same-utterance score: {lo_same:.2f}. Highest different-utterance score: {hi_diff:.2f}.**"]
    out = ROOT / "reports" / f"{dt.datetime.now():%Y-%m-%d_%H%M%S}_twins.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nlowest same-utterance {lo_same:.2f}, highest different-utterance {hi_diff:.2f}\nreport: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
