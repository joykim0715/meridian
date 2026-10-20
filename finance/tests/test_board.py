import unittest
from datetime import datetime, timedelta, timezone

from finance.board import freshness, last_completed_us_session

KST = timezone(timedelta(hours=9))


class BoardTests(unittest.TestCase):
    def test_before_dawn_the_us_close_is_still_friday(self):
        now = datetime(2026, 10, 20, 2, 27, tzinfo=KST)
        self.assertEqual(last_completed_us_session(now).isoformat(), "2026-10-16")

    def test_after_dawn_monday_close_is_available(self):
        now = datetime(2026, 10, 20, 7, 30, tzinfo=KST)
        self.assertEqual(last_completed_us_session(now).isoformat(), "2026-10-19")

    def test_old_fx_print_is_marked_stopped(self):
        text, kind = freshness("daily", "2026-10-09", last_completed_us_session(datetime(2026, 10, 20, 2, 27, tzinfo=KST)))
        self.assertEqual(kind, "stale")
        self.assertIn("아직 없습니다", text)

    def test_rising_fear_and_rates_pause_qqq(self):
        from finance.board import investment_action

        self.assertIn("오늘은 사지 않고", investment_action("QQQ", "up", "up", "flat"))
        self.assertIn("일부만", investment_action("S&P500", "up", "down", "flat"))
        self.assertIn("환율 발표가 최근 마감보다 늦다", investment_action("TIGER", "down", "down", "up", True))
        self.assertIn("같은 지수", investment_action("Vanguard", "down", "down", "down"))
        text, kind = freshness("daily", "2026-10-16", last_completed_us_session(datetime(2026, 10, 20, 2, 27, tzinfo=KST)))
        self.assertEqual(kind, "current")
        self.assertIn("최근 미국장", text)

    def test_outlook_withholds_when_windows_disagree(self):
        from finance.board import outlook_text, stance_for

        rising = [{"value": index} for index in range(30)]
        text, kind = outlook_text(rising)
        self.assertEqual(kind, "continue")
        self.assertIn("확정은 아니다", text)
        mixed = [{"value": 20 - index} for index in range(25)] + [{"value": index} for index in range(6)]
        text, kind = outlook_text(mixed)
        self.assertEqual(kind, "conflict")
        self.assertIn("보류", text)
        self.assertEqual(stance_for("QQQ", "up", "up", "flat"), "pause")
        self.assertEqual(stance_for("S&P500", "down", "up", "up"), "scale")


if __name__ == "__main__":
    unittest.main()
