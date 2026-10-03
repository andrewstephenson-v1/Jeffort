import unittest
from datetime import date, timedelta

from solution import business_days_between as bd


class BusinessDaysTest(unittest.TestCase):
    def test_full_week(self):
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 11)), 5)  # Mon -> next Mon

    def test_end_is_exclusive(self):
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 8)), 4)  # Mon..Thu

    def test_weekend_only(self):
        self.assertEqual(bd(date(2024, 3, 9), date(2024, 3, 11)), 0)  # Sat, Sun

    def test_same_day_and_reversed(self):
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 4)), 0)
        with self.assertRaises(ValueError):
            bd(date(2024, 3, 5), date(2024, 3, 4))

    def test_weekday_holiday_removed_once(self):
        h = [date(2024, 3, 6), date(2024, 3, 6)]
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 11), h), 4)

    def test_irrelevant_holidays_ignored(self):
        h = [date(2024, 3, 9), date(2024, 1, 1), date(2024, 3, 11)]  # Sat, outside, == end
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 11), h), 5)

    def test_holiday_on_start_counts(self):
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 6), [date(2024, 3, 4)]), 1)

    def test_holidays_can_be_a_generator_or_set(self):
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 11), (d for d in [date(2024, 3, 5)])), 4)
        self.assertEqual(bd(date(2024, 3, 4), date(2024, 3, 11), {date(2024, 3, 5)}), 4)

    def test_long_range(self):
        self.assertEqual(bd(date(2000, 1, 3), date(2000, 1, 3) + timedelta(weeks=52)), 5 * 52)


if __name__ == '__main__':
    unittest.main()
