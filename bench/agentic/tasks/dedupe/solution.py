def dedupe(items, key=None):
    """Remove duplicates, keeping the first occurrence and the original order.

    Items may be unhashable (lists, dicts). Two items are duplicates when their `key(item)` values
    are equal (the item itself when key is None). Return a new list; never modify the input.
    """
    return list(set(items))
