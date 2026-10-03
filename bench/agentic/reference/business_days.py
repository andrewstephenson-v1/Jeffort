from datetime import timedelta


def business_days_between(start, end, holidays=()):
    if end < start:
        raise ValueError('end before start')
    off = {h for h in holidays if start <= h < end and h.weekday() < 5}
    total = sum(1 for i in range((end - start).days) if (start + timedelta(days=i)).weekday() < 5)
    return total - len(off)
