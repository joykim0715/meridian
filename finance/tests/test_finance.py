import io
import json
import tempfile
import unittest
import urllib.error
from datetime import date, timedelta
from email.message import Message
from pathlib import Path
from unittest.mock import patch

from finance.http_client import HttpClient, redact
from finance.models import Observation
from finance.snapshot import build_snapshot
from finance.sources.cboe import parse_cboe_csv
from finance.sources.ecos import parse_ecos_rows
from finance.sources.fmp import parse_fmp_history
from finance.sources.fred import parse_fred_csv
from finance.sources.kis import parse_kis_daily
from finance.sources.krx import KrxSource
from finance.storage.db import Store
from finance.validation.checks import row_problems, validate_stored


FRED_SERIES = {
    "symbol": "VIXCLS",
    "price_kind": "level",
    "frequency": "daily",
    "market": "US",
}


class ParseTests(unittest.TestCase):
    def test_fred_skips_missing_and_keeps_value(self):
        text = "observation_date,VIXCLS\n2026-10-13,.\n2026-10-14,16.87\n"
        rows = parse_fred_csv(text, FRED_SERIES)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].obs_date, "2026-10-14")
        self.assertEqual(rows[0].close, 16.87)
        self.assertEqual(rows[0].vintage_date, "")

    def test_cboe_ohlc_and_close_only(self):
        ohlc = parse_cboe_csv("DATE,OPEN,HIGH,LOW,CLOSE\n10/14/2026,15.2,17.1,15.0,16.87\n", {"symbol": "VIX", "layout": "ohlc"})
        close_only = parse_cboe_csv("DATE,VVIX\n10/14/2026,91.2\n", {"symbol": "VVIX", "layout": "close"})
        self.assertEqual(ohlc[0].high, 17.1)
        self.assertEqual(ohlc[0].price_kind, "ohlcv")
        self.assertEqual(close_only[0].close, 91.2)
        self.assertEqual(close_only[0].price_kind, "level")
        self.assertNotEqual(ohlc[0].instrument_id, "fred:VIXCLS")

    def test_krx_keeps_exact_index_and_selected_etf(self):
        day = date.today()
        while day.weekday() >= 5:
            day -= timedelta(days=1)

        class FakeHttp:
            def get_json(self, url, headers=None):
                if "kospi_dd_trd" in url:
                    return {"OutBlock_1": [
                        {"IDX_NM": "코스피", "BAS_DD": "20261014", "CLSPRC_IDX": "1"},
                        {"IDX_NM": "코스피 200", "BAS_DD": "20261014", "CLSPRC_IDX": "390.5", "OPNPRC_IDX": "388", "HGPRC_IDX": "391", "LWPRC_IDX": "387"},
                    ]}
                if "kosdaq_dd_trd" in url:
                    return {"OutBlock_1": []}
                return {"OutBlock_1": [
                    {"ISU_CD": "069500", "BAS_DD": "20261014", "TDD_CLSPRC": "45,120", "TDD_OPNPRC": "45000", "TDD_HGPRC": "45200", "TDD_LWPRC": "44900"},
                    {"ISU_CD": "999999", "BAS_DD": "20261014", "TDD_CLSPRC": "10"},
                ]}

        result = KrxSource(FakeHttp(), api_key="test-key", since=day.isoformat()).collect()
        ids = {row.instrument_id for row in result.observations}
        self.assertEqual(ids, {"krx:KOSPI200", "krx:069500"})
        etf = next(row for row in result.observations if row.instrument_id == "krx:069500")
        self.assertEqual(etf.close, 45120)
        self.assertIsNone(etf.adjusted_close)

    def test_krx_without_key_stores_nothing(self):
        result = KrxSource(None, api_key="").collect()
        self.assertEqual(result.observations, [])
        self.assertEqual(result.issues[0].code, "AUTH_REQUIRED")

    def test_fmp_separates_adjusted_close(self):
        rows = parse_fmp_history("SPY", [{"date": "2026-10-14", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "adjClose": 1.4, "volume": 10}])
        self.assertEqual(rows[0].close, 1.5)
        self.assertEqual(rows[0].adjusted_close, 1.4)
        self.assertEqual(rows[0].instrument_id, "fmp:SPY")

    def test_kis_quotes_only(self):
        source = Path("finance/sources/kis.py").read_text(encoding="utf-8")
        self.assertNotIn("order-cash", source)
        self.assertNotIn("TTTC0802U", source)
        rows = parse_kis_daily("069500", [{"stck_bsop_date": "20261014", "stck_clpr": "45120", "stck_oprc": "45000", "stck_hgpr": "45200", "stck_lwpr": "44900"}], "KR")
        self.assertEqual(rows[0].price_kind, "adjusted_close")
        self.assertEqual(rows[0].close, 45120)

    def test_ecos_skips_monthly_stamp(self):
        rows = parse_ecos_rows({"symbol": "USD_KRW", "price_kind": "fx_rate"}, [{"TIME": "202610", "DATA_VALUE": "1340"}, {"TIME": "20261014", "DATA_VALUE": "1340.5"}])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].close, 1340.5)


class StorageTests(unittest.TestCase):
    def test_upsert_is_idempotent_and_validation_catches_bad_ohlc(self):
        folder = tempfile.mkdtemp()
        store = Store(Path(folder) / "market.sqlite")
        try:
            store.ensure_instrument({
                "instrument_id": "cboe:VIX",
                "provider_id": "cboe",
                "symbol": "VIX",
                "name": "Cboe VIX",
                "asset_class": "volatility",
                "market": "US",
                "currency": None,
                "unit": "index",
                "price_kind": "ohlcv",
                "frequency": "daily",
                "note": "변동성",
            })
            row = Observation("cboe:VIX", "2026-10-14", "ohlcv", close=16.87, open=15.0, high=17.0, low=14.0)
            first = store.upsert([row])
            second = store.upsert([row])
            self.assertEqual(first["inserted"], 1)
            self.assertEqual(second["unchanged"], 1)
            self.assertEqual(store.count_observations(), 1)
            store.upsert([Observation("cboe:VIX", "2026-10-13", "ohlcv", close=20, open=10, high=11, low=9)])
            issues = validate_stored(store)
            self.assertTrue(any(issue["code"] == "ohlc" for issue in issues))
        finally:
            store.close()

    def test_snapshot_has_no_recommendation(self):
        folder = tempfile.mkdtemp()
        store = Store(Path(folder) / "market.sqlite")
        try:
            store.ensure_instrument({
                "instrument_id": "fred:DGS10",
                "provider_id": "fred",
                "symbol": "DGS10",
                "name": "미국 10년 국채금리",
                "asset_class": "rate",
                "market": "US",
                "currency": "USD",
                "unit": "percent",
                "price_kind": "yield_percent",
                "frequency": "daily",
                "note": "수익률",
            })
            store.upsert([Observation("fred:DGS10", "2026-10-14", "yield_percent", close=4.1)])
            payload = build_snapshot(store)
            text = json.dumps(payload, ensure_ascii=False)
            self.assertIsNone(payload["recommendation"])
            self.assertIsNone(payload["analysis"])
            self.assertNotIn("매수", text)
            self.assertNotIn("점수", text)
            self.assertTrue(payload["missing"])
        finally:
            store.close()


class GuardTests(unittest.TestCase):
    def test_negative_price_rejected_and_negative_spread_kept(self):
        self.assertIn("negative_value", row_problems(Observation("cboe:VIX", "2026-10-14", "ohlcv", close=-1)))
        self.assertEqual(row_problems(Observation("fred:T10Y2Y", "2026-10-14", "spread_percent", close=-0.2)), [])

    def test_redact_and_retry(self):
        self.assertNotIn("secret-value", redact("https://example.test/api?api_key=secret-value&x=1"))
        calls = {"n": 0}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"ok"

        def fake_urlopen(_request, timeout=0):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.URLError("timed out")
            return Response()

        with patch("urllib.request.urlopen", fake_urlopen):
            text = HttpClient(sleep=lambda _seconds: None).get_text("https://example.test/data")
        self.assertEqual(text, "ok")
        self.assertEqual(calls["n"], 3)

        def unauthorized(_request, timeout=0):
            calls["n"] += 1
            raise urllib.error.HTTPError("https://example.test", 401, "no", Message(), io.BytesIO(b"api_key=secret-value"))

        calls["n"] = 0
        with patch("urllib.request.urlopen", unauthorized):
            with self.assertRaises(Exception) as caught:
                HttpClient(sleep=lambda _seconds: None).get_text("https://example.test/data")
        self.assertEqual(calls["n"], 1)
        self.assertNotIn("secret-value", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
