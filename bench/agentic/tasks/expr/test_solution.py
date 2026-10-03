import unittest
from solution import evaluate


class EvaluateTest(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(evaluate('2+3*4'), 14)
        self.assertEqual(evaluate('(2+3)*4'), 20)
        self.assertEqual(evaluate('2*3+4*5'), 26)

    def test_left_associative(self):
        self.assertEqual(evaluate('10-4-3'), 3)
        self.assertEqual(evaluate('100/10/5'), 2)

    def test_unary_minus(self):
        self.assertEqual(evaluate('-3'), -3)
        self.assertEqual(evaluate('-(2+3)'), -5)
        self.assertEqual(evaluate('2*-3'), -6)
        self.assertEqual(evaluate('--4'), 4)
        self.assertEqual(evaluate('3 - -2'), 5)

    def test_decimals_and_whitespace(self):
        self.assertAlmostEqual(evaluate(' 1.5 * 2 '), 3.0)
        self.assertAlmostEqual(evaluate('0.1+0.2'), 0.3)
        self.assertEqual(evaluate('7'), 7)

    def test_nested(self):
        self.assertEqual(evaluate('((1+2)*(3+4))-(5/(2+3))'), 20)

    def test_division_by_zero(self):
        with self.assertRaises(ZeroDivisionError):
            evaluate('1/0')
        with self.assertRaises(ZeroDivisionError):
            evaluate('4/(2-2)')

    def test_malformed(self):
        for bad in ['', '   ', '2+', '(1', '1)', '1 2', 'abc', '2**3', '()', '*3', '1+*2',
                    "__import__('os')", '1..2']:
            with self.assertRaises(ValueError, msg=repr(bad)):
                evaluate(bad)


if __name__ == '__main__':
    unittest.main()
