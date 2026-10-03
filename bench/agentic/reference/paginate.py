def paginate(items, page, per_page):
    if page < 1:
        return []
    start = (page - 1) * per_page
    return items[start:start + per_page]
