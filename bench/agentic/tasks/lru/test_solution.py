import unittest
from solution import LRUCache


class LRUTest(unittest.TestCase):
    def test_evicts_least_recently_used(self):
        c = LRUCache(2)
        c.put('a', 1)
        c.put('b', 2)
        c.put('c', 3)
        self.assertNotIn('a', c)
        self.assertIn('b', c)
        self.assertIn('c', c)

    def test_get_refreshes(self):
        c = LRUCache(2)
        c.put('a', 1)
        c.put('b', 2)
        self.assertEqual(c.get('a'), 1)
        c.put('c', 3)
        self.assertIn('a', c)
        self.assertNotIn('b', c)

    def test_put_existing_refreshes_and_updates(self):
        c = LRUCache(2)
        c.put('a', 1)
        c.put('b', 2)
        c.put('a', 10)
        c.put('c', 3)
        self.assertEqual(c.get('a'), 10)
        self.assertNotIn('b', c)

    def test_contains_and_len_do_not_refresh(self):
        c = LRUCache(2)
        c.put('a', 1)
        c.put('b', 2)
        self.assertIn('a', c)
        self.assertEqual(len(c), 2)
        c.put('c', 3)
        self.assertNotIn('a', c)

    def test_default_and_capacity(self):
        c = LRUCache(1)
        self.assertEqual(c.get('x', 'none'), 'none')
        c.put('a', 1)
        c.put('b', 2)
        self.assertEqual(len(c), 1)
        with self.assertRaises(ValueError):
            LRUCache(0)


if __name__ == '__main__':
    unittest.main()
