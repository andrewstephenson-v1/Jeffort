import re

_UNITS = {'d': 86400, 'h': 3600, 'm': 60, 's': 1}


def parse_duration(text):
    s = text.strip()
    if not s:
        raise ValueError('empty')
    pos, total, seen = 0, 0, set()
    part = re.compile(r'(\d+)([a-z])\s*')
    while pos < len(s):
        m = part.match(s, pos)
        if not m or m.group(2) not in _UNITS or m.group(2) in seen:
            raise ValueError(text)
        seen.add(m.group(2))
        total += int(m.group(1)) * _UNITS[m.group(2)]
        pos = m.end()
    return total
