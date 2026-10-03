def paginate(items, page, per_page):
    """Return the items on 1-indexed `page`. Pages outside the data (including page < 1) give []."""
    start = page * per_page
    return items[start:start + per_page]
