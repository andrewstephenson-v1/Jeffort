def parse_duration(text):
    """Seconds in a duration string made of integer parts with units d, h, m, s.

    "1h30m" -> 5400, "90s" -> 90, "1d2h3m4s" -> 93784. Parts may appear in any order and may be
    separated by spaces ("  1h 30m "). Each unit may appear at most once. Raise ValueError for an
    empty string, a number with no unit, a unit with no number, an unknown unit, a repeated unit,
    or a non-integer such as "1.5h".
    """
    raise NotImplementedError
