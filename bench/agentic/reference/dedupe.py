def dedupe(items, key=None):
    seen, out = [], []
    for item in items:
        k = item if key is None else key(item)
        if not any(k == s for s in seen):
            seen.append(k)
            out.append(item)
    return out
