import unittest
from solution import parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_duration('1h30m'), 5400)
        self.assertEqual(parse_duration('90s'), 90)
        self.assertEqual(parse_duration('2d'), 172800)
        self.assertEqual(parse_duration('1d2h3m4s'), 93784)

    def test_order_and_spaces(self):
        self.assertEqual(parse_duration('30m1h'), 5400)
        self.assertEqual(parse_duration('  1h 30m  '), 5400)
        self.assertEqual(parse_duration('0s'), 0)

    def test_invalid(self):
        for bad in ['', '   ', '5', 'h', '1x', '1h1h', '1.5h', '-1h', '1h 30', 'abc', '1h30mm']:
            with self.assertRaises(ValueError, msg=repr(bad)):
                parse_duration(bad)


if __name__ == '__main__':
    unittest.main()
