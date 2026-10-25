"""Vector clocks: order events by what each device had seen, never by wall time."""
import random
import time
from collections.abc import Callable


def merge(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: max(a.get(k, 0), b.get(k, 0)) for k in a.keys() | b.keys()}


def happened_before(a: dict[str, int], b: dict[str, int]) -> bool:
    """True if a causally precedes b."""
    keys = a.keys() | b.keys()
    return all(a.get(k, 0) <= b.get(k, 0) for k in keys) and a != b


def concurrent(a: dict[str, int], b: dict[str, int]) -> bool:
    return a != b and not happened_before(a, b) and not happened_before(b, a)


def wall_clock(mode: str = "off") -> Callable[[], float]:
    """The device's (untrusted) wall clock. Hostile modes let one laptop play the broken phone:

    off  - real time
    1970 - the phone has reset to the epoch and counts up from there
    jump - every reading randomly lands in 1970, now, or 2099
    """
    match mode.lower():
        case "1970":
            start = time.time()
            return lambda: time.time() - start
        case "jump":
            rng = random.Random()
            return lambda: rng.choice([rng.uniform(0, 86_400), time.time(), 4_070_908_800 + rng.uniform(0, 86_400)])
        case _:
            return time.time
