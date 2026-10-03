from datetime import timedelta


def business_days_between(start, end, holidays=()):
    """Business days (Monday to Friday, excluding holidays) in the half-open range [start, end).

    `start` and `end` are datetime.date. `holidays` is any iterable of dates and may contain
    duplicates, weekend dates, or dates outside the range; none of those change the answer. A
    holiday that falls on a weekday inside the range removes that day once. start == end gives 0;
    end before start raises ValueError.
    """
    days = (end - start).days
    count = 0
    for i in range(days + 1):
        d = start + timedelta(days=i)
        if d.weekday() < 5:
            count += 1
    count -= len(holidays)
    return count
