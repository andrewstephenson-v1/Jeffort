import unittest
from solution import dedupe


class DedupeTest(unittest.TestCase):
    def test_keeps_first_and_order(self):
        self.assertEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])

    def test_unhashable(self):
        self.assertEqual(dedupe([[1], [2], [1]]), [[1], [2]])
        self.assertEqual(dedupe([{'a': 1}, {'a': 1}, {'b': 2}]), [{'a': 1}, {'b': 2}])

    def test_key_function(self):
        words = ['Apple', 'apple', 'Banana', 'APPLE', 'banana']
        self.assertEqual(dedupe(words, key=str.lower), ['Apple', 'Banana'])

    def test_key_with_unhashable_keys(self):
        rows = [{'id': [1]}, {'id': [2]}, {'id': [1]}]
        self.assertEqual(dedupe(rows, key=lambda r: r['id']), [{'id': [1]}, {'id': [2]}])

    def test_empty_and_input_untouched(self):
        self.assertEqual(dedupe([]), [])
        data = [1, 1, 2]
        dedupe(data)
        self.assertEqual(data, [1, 1, 2])

    def test_equal_but_different_types(self):
        self.assertEqual(dedupe([1, 1.0, True, 'a']), [1, 'a'])


if __name__ == '__main__':
    unittest.main()
