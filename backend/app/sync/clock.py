"""Vector clocks: order events by what each device had seen, never by wall time."""


def merge(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: max(a.get(k, 0), b.get(k, 0)) for k in a.keys() | b.keys()}


def happened_before(a: dict[str, int], b: dict[str, int]) -> bool:
    """True if a causally precedes b."""
    keys = a.keys() | b.keys()
    return all(a.get(k, 0) <= b.get(k, 0) for k in keys) and a != b


def concurrent(a: dict[str, int], b: dict[str, int]) -> bool:
    return a != b and not happened_before(a, b) and not happened_before(b, a)
