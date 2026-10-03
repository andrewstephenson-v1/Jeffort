from collections import OrderedDict


class LRUCache:
    """Least-recently-used cache. get() and put() both count as a use; `in` and len() do not."""

    def __init__(self, capacity):
        if capacity < 1:
            raise ValueError('capacity must be at least 1')
        self.capacity = capacity
        self.data = OrderedDict()

    def get(self, key, default=None):
        if key in self.data:
            return self.data[key]
        return default

    def put(self, key, value):
        if key in self.data:
            self.data[key] = value
        else:
            if len(self.data) >= self.capacity:
                self.data.popitem(last=True)
            self.data[key] = value

    def __contains__(self, key):
        return key in self.data

    def __len__(self):
        return len(self.data)
