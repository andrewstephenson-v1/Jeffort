import unittest
from solution import paginate


class PaginateTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_partial_last_page(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_past_the_end(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])

    def test_page_zero_and_negative(self):
        self.assertEqual(paginate(list(range(10)), 0, 3), [])
        self.assertEqual(paginate(list(range(10)), -1, 3), [])

    def test_empty(self):
        self.assertEqual(paginate([], 1, 3), [])


if __name__ == '__main__':
    unittest.main()
