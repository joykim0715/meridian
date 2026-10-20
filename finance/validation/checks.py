import math
from datetime import date, datetime, timezone

from finance.catalog import ECOS_SERIES, FRED_SERIES

REQUESTED_START = {f"fred:{series['symbol']}": series["start"] for series in FRED_SERIES}
ALLOW_NEGATIVE = set()
for series in FRED_SERIES:
    if series["allow_negative"]:
        ALLOW_NEGATIVE.add(f"fred:{series['symbol']}")
for series in ECOS_SERIES:
    if series["allow_negative"]:
        ALLOW_NEGATIVE.add(f"ecos:{series['symbol']}")


def _number_ok(value):
    return value is None or (isinstance(value, (int, float)) and math.isfinite(value))


def row_problems(row):
    problems = []
    try:
        obs = date.fromisoformat(row.obs_date)
    except ValueError:
        return ["bad_date"]
    if obs > date.today():
        problems.append("future_date")
    for value in (row.open, row.high, row.low, row.close, row.adjusted_close, row.volume, row.value):
        if not _number_ok(value):
            problems.append("non_finite")
            break
    if row.close is None:
        problems.append("missing_close")
    elif row.price_kind == "flag" and row.close not in (0, 1):
        problems.append("bad_flag")
    elif row.close < 0 and row.instrument_id not in ALLOW_NEGATIVE:
        problems.append("negative_value")
    elif row.close == 0 and row.price_kind in ("level", "ohlcv", "fx_rate", "close", "adjusted_close"):
        problems.append("zero_value")
    if row.price_kind == "close" and row.adjusted_close is not None:
        problems.append("adjusted_mixed_into_close")
    return problems


def validate_stored(store):
    issues = []
    today = datetime.now(timezone.utc).date()
    for instrument in store.instruments():
        rows = store.observations(instrument["instrument_id"])
        if not rows:
            issues.append(_issue(instrument, "missing_series", "저장된 관측값이 없다.", "error"))
            continue
        identity = [(row["obs_date"], row["vintage_date"], row["price_kind"]) for row in rows]
        if [row["obs_date"] for row in rows] != sorted(row["obs_date"] for row in rows):
            issues.append(_issue(instrument, "date_order", "거래일 순서가 오름차순이 아니다.", "error"))
        if len(identity) != len(set(identity)):
            issues.append(_issue(instrument, "duplicate_date", "같은 거래일과 빈티지가 두 번 이상이다.", "error"))
        latest = date.fromisoformat(rows[-1]["obs_date"])
        lag = (today - latest).days
        limit = {"daily": 12 if instrument["asset_class"] == "fx" else 7, "weekly": 14, "monthly": 50}.get(
            instrument["frequency"], 7
        )
        if lag > limit:
            issues.append(_issue(instrument, "stale", f"최신 관측일이 {rows[-1]['obs_date']}이다.", "warning"))
        requested = REQUESTED_START.get(instrument["instrument_id"])
        if requested:
            gap_days = (date.fromisoformat(rows[0]["obs_date"]) - date.fromisoformat(requested)).days
            if gap_days > 14:
                issues.append(
                    _issue(
                        instrument,
                        "short_history",
                        f"요청 시작일 {requested}보다 늦은 {rows[0]['obs_date']}부터 저장되어 있다.",
                        "warning",
                    )
                )
        if instrument["unit"] == "krw" and instrument["currency"] not in (None, "KRW"):
            issues.append(_issue(instrument, "unit_mismatch", "통화와 단위가 다르다.", "error"))
        if instrument["unit"] == "usd" and instrument["currency"] not in (None, "USD"):
            issues.append(_issue(instrument, "unit_mismatch", "통화와 단위가 다르다.", "error"))
        for row in rows:
            if row["status"] != "ok":
                issues.append(_issue(instrument, "incomplete", f"{row['obs_date']} 상태가 {row['status']}이다.", "error"))
            ohlc = _ohlc_problem(row)
            if ohlc:
                issues.append(_issue(instrument, "ohlc", f"{row['obs_date']} {ohlc}", "error"))
            if row["price_kind"] == "close" and row["adjusted_close"] is not None:
                issues.append(_issue(instrument, "adjusted_mixed_into_close", row["obs_date"], "error"))
    return issues


def _ohlc_problem(row):
    values = [row["open"], row["high"], row["low"], row["close"]]
    if any(value is None for value in values):
        return None
    if row["high"] < row["low"]:
        return "고가가 저가보다 낮다."
    if row["high"] < max(row["open"], row["close"]) or row["low"] > min(row["open"], row["close"]):
        return f"시가 {row['open']} 고가 {row['high']} 저가 {row['low']} 종가 {row['close']}"
    return None


def _issue(instrument, code, message, severity):
    return {
        "instrument_id": instrument["instrument_id"],
        "code": code,
        "message": message,
        "severity": severity,
    }
