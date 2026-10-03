import unittest
from solution import toposort


class TopoSortTest(unittest.TestCase):
    def test_chain(self):
        self.assertEqual(toposort({'c': ['b'], 'b': ['a'], 'a': []}), ['a', 'b', 'c'])

    def test_ties_pick_smallest(self):
        self.assertEqual(toposort({'d': ['b', 'c'], 'b': [], 'c': [], 'a': []}), ['a', 'b', 'c', 'd'])

    def test_smallest_ready_not_smallest_overall(self):
        # 'a' needs 'z', so 'b' must come before 'a' even though 'a' < 'b'
        self.assertEqual(toposort({'a': ['z'], 'b': [], 'z': []}), ['b', 'z', 'a'])

    def test_deps_only_nodes_included(self):
        self.assertEqual(toposort({'app': ['lib']}), ['lib', 'app'])

    def test_empty_and_isolated(self):
        self.assertEqual(toposort({}), [])
        self.assertEqual(toposort({'x': [], 'y': []}), ['x', 'y'])

    def test_duplicate_deps(self):
        self.assertEqual(toposort({'b': ['a', 'a'], 'a': []}), ['a', 'b'])

    def test_cycles(self):
        for g in [{'a': ['b'], 'b': ['a']}, {'a': ['a']}, {'a': ['b'], 'b': ['c'], 'c': ['a'], 'd': []}]:
            with self.assertRaisesRegex(ValueError, 'cycle'):
                toposort(g)

    def test_input_not_modified(self):
        g = {'b': ['a'], 'a': []}
        toposort(g)
        self.assertEqual(g, {'b': ['a'], 'a': []})


if __name__ == '__main__':
    unittest.main()
