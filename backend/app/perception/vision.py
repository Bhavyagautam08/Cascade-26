"""Read a handwritten wholesale slip with a local vision model via Ollama, in three steps:

1. Orientation. Phone photos of slips are often sideways; read sideways, the model invents numbers
   (1 kg -> 4000 g, 0.5 kg -> 500 kg). Asked directly, it claims every photo is upright. So we let it
   read a few lines in each of the 4 rotations and keep the rotation it reads most confidently
   (mean token log-probability) - 12/12 correct on real photos.
2. Transcription. Upright, it transcribes handwriting well. It writes the text exactly as written;
   token log-probabilities give each line a real confidence (the least certain digit drives it), so a
   doubtful number is flagged for the vendor instead of a flat self-reported 0.95.
3. Structure. slip_lines.parse_slip turns the lines into item / qty / unit / price deterministically,
   then normalize() maps names and units onto the ledger's lexicon.
"""
import difflib
import io
import math

from pydantic import BaseModel

from app.perception.slip_lines import parse_slip


class SlipLine(BaseModel):
    item: str
    qty: float | None = None
    unit: str | None = None
    amount_rupees: float | None = None
    confidence: float
    text: str | None = None          # the line as transcribed, so the vendor sees what was read
    notes: list[str] = []


class Slip(BaseModel):
    supplier: str | None = None
    lines: list[SlipLine]
    total_rupees: float | None = None
    rotation: int = 0                # degrees counter-clockwise applied to make the photo upright
    text: str | None = None          # full transcription
    warnings: list[str] = []         # slip-level problems the vendor must look at


DOUBTFUL = 0.5   # confidence given to a line that fails a consistency check; the UI flags < 0.6


def check_consistency(slip: Slip) -> Slip:
    """Catch what token confidence cannot: a value the model never read has no low-confidence token.

    - If most lines carry a price, a line without one probably lost it -> flag that line.
    - If the prices don't add up to the written total, something was misread -> flag every line.
    """
    lines = [l.model_copy() for l in slip.lines]
    warnings = list(slip.warnings)
    priced = [l for l in lines if l.amount_rupees is not None]
    if priced and len(priced) < len(lines):
        for l in lines:
            if l.amount_rupees is None:
                l.confidence = min(l.confidence, DOUBTFUL)
                l.notes = [*l.notes, "price missing (other lines have one)"]
    if slip.total_rupees is not None and priced:
        s = sum(l.amount_rupees for l in priced)
        if abs(s - slip.total_rupees) > 1:
            warnings.append(f"line prices add up to {s:g}, the slip's total says {slip.total_rupees:g}")
            for l in lines:
                l.confidence = min(l.confidence, DOUBTFUL)
    return slip.model_copy(update={"lines": lines, "warnings": warnings})


# "edge to edge" matters: with a plain "transcribe" prompt the model dropped a right-hand price column
# (8 of 10 prices on eval sample 004); this wording recovers all 10 and invents none on price-less lists.
TRANSCRIBE = ("Transcribe the handwritten text in this image exactly as written. Copy each line completely, "
              "from the left edge of the page to the right edge, including any numbers or prices written far "
              "to the right of the line (for example 320/-), and any total at the bottom. Keep numbers and "
              "units exactly as written. Do not translate, explain or add anything that is not written.")
PROBE_TOKENS = 48        # enough to read 3-4 lines when choosing the rotation
READ_TOKENS = 1024
PROBE_SIZE = 896         # px, long side; the model resizes internally anyway
READ_SIZE = 1280


def _jpeg(im, size: int) -> bytes:
    im = im.copy()
    im.thumbnail((size, size))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def _line_confidences(content: str, logprobs) -> list[float]:
    """Per transcribed line: exp of the lowest log-prob among its digit tokens, or of the mean of its
    tokens when it has no digits. A single doubtful digit makes the whole line doubtful."""
    lines: list[list[tuple[str, float]]] = [[]]
    for tok in logprobs or []:
        parts = tok.token.split("\n")
        for j, part in enumerate(parts):
            if j:
                lines.append([])
            if part.strip():
                lines[-1].append((part, tok.logprob))
    confs: list[float] = []
    for toks in lines:   # one entry per line of the reply, empty lines included, so indexes match content
        if not toks:     # no evidence for this line -> 0.5 ("unknown"), never a made-up high value
            confs.append(0.5)
            continue
        digits = [lp for t, lp in toks if any(ch.isdigit() for ch in t)]
        lp = min(digits) if digits else sum(lp for _, lp in toks) / len(toks)
        confs.append(round(math.exp(lp), 3))
    n = len(content.split("\n"))
    return (confs + [0.5] * n)[:n]


def normalize(slip: Slip, lex: dict) -> Slip:
    """Make slip lines match the ledger's vocabulary, so a slip's tomatoes and a spoken "tamatar" land
    in the same inventory account and in the same unit. Names match the lexicon exactly or, for
    handwriting slips such as "pyaaaz", by close spelling (noted on the line)."""
    items = {k.lower(): v for k, v in lex.get("items", {}).items()}
    items.update({v.lower(): v for v in lex.get("items", {}).values()})
    units = {k.lower(): v for k, v in lex.get("units", {}).items()}
    lines = []
    for line in slip.lines:
        name = line.item.strip().lower()
        notes = list(line.notes)
        if name in items:
            name = items[name]
        else:
            close = difflib.get_close_matches(name, list(items), n=1, cutoff=0.8)
            if close:
                notes.append(f"read as '{name}', matched '{close[0]}'")
                name = items[close[0]]
        unit, qty = line.unit, line.qty
        if unit and unit.strip().lower() in units:
            u = units[unit.strip().lower()]
            unit, qty = u["unit"], (round(qty * u["factor"], 6) if qty is not None else None)
        lines.append(line.model_copy(update={"item": name, "unit": unit.lower() if unit else unit, "qty": qty,
                                             "notes": notes}))
    return slip.model_copy(update={"lines": lines})


class SlipReader:
    def __init__(self, host: str, model: str):
        from ollama import Client

        self.client = Client(host=host)
        self.model = self.name = model

    def _read(self, image: bytes, tokens: int):
        return self.client.chat(
            model=self.model,
            messages=[{"role": "user", "content": TRANSCRIBE, "images": [image]}],
            options={"temperature": 0, "num_predict": tokens},
            think=False,    # needs a non-thinking model (qwen3-vl:4b-instruct); see extractor.py
            logprobs=True,
        )

    def orient(self, im) -> int:
        """Rotation (degrees CCW) under which the model reads the page most confidently."""
        def score(deg: int) -> float:
            r = self._read(_jpeg(im.rotate(deg, expand=True), PROBE_SIZE), PROBE_TOKENS)
            lps = [t.logprob for t in r.logprobs or []]
            return sum(lps) / len(lps) if lps else -math.inf
        return max((0, 90, 180, 270), key=score)

    def read(self, image_bytes: bytes) -> Slip:
        from PIL import Image, ImageOps

        im = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
        rotation = self.orient(im)
        r = self._read(_jpeg(im.rotate(rotation, expand=True), READ_SIZE), READ_TOKENS)
        content = r.message.content            # unstripped, so its lines align with the token log-probs
        text_lines = content.split("\n")
        confs = _line_confidences(content, r.logprobs)
        supplier, total, parsed = parse_slip(text_lines)
        lines = [SlipLine(item=p.item or "?", qty=p.qty, unit=p.unit, amount_rupees=p.amount_rupees,
                          confidence=confs[i] if i < len(confs) else 0.5, text=text_lines[i].strip(), notes=p.notes)
                 for i, p in parsed]
        return check_consistency(Slip(supplier=supplier, lines=lines, total_rupees=total, rotation=rotation,
                                      text=content.strip()))
