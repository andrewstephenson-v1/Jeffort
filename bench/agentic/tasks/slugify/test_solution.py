import unittest
from solution import slugify


class SlugifyTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify('Hello, World!'), 'hello-world')

    def test_collapses_and_trims(self):
        self.assertEqual(slugify('  Multiple   spaces '), 'multiple-spaces')
        self.assertEqual(slugify('---a---b---'), 'a-b')

    def test_accents(self):
        self.assertEqual(slugify('Café au lait'), 'cafe-au-lait')

    def test_digits_and_empty(self):
        self.assertEqual(slugify('Top 10 of 2024'), 'top-10-of-2024')
        self.assertEqual(slugify(''), '')
        self.assertEqual(slugify('!!!'), '')


if __name__ == '__main__':
    unittest.main()
