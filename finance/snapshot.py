import json
from datetime import datetime, timezone

from finance.validation.checks import validate_stored


def build_snapshot(store):
    issues = validate_stored(store)
    by_instrument = {}
    for issue in issues:
        by_instrument.setdefault(issue["instrument_id"], []).append(issue)
    instruments = []
    for instrument in store.instruments():
        rows = store.observations(instrument["instrument_id"])
        latest = rows[-1] if rows else None
        instruments.append(
            {
                "instrument_id": instrument["instrument_id"],
                "provider_id": instrument["provider_id"],
                "symbol": instrument["symbol"],
                "name": instrument["name"],
                "market": instrument["market"],
                "currency": instrument["currency"],
                "unit": instrument["unit"],
                "price_kind": instrument["price_kind"],
                "frequency": instrument["frequency"],
                "note": instrument["note"],
                "observations": len(rows),
                "first_obs_date": rows[0]["obs_date"] if rows else None,
                "latest_obs_date": latest["obs_date"] if latest else None,
                "latest_close": latest["close"] if latest else None,
                "latest_available_at": latest["available_at"] if latest else None,
                "latest_collected_at": latest["collected_at"] if latest else None,
                "vintage_date": latest["vintage_date"] if latest else None,
                "quality": by_instrument.get(instrument["instrument_id"], []),
            }
        )
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stage": "v1",
        "analysis": None,
        "recommendation": None,
        "instruments": instruments,
        "source_issues": [dict(row) for row in store.latest_issues()],
        "missing": _missing(instruments),
    }


def write_snapshot(store, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_snapshot(store)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def _missing(instruments):
    notes = []
    present = {item["instrument_id"] for item in instruments if item["observations"]}
    expected = {
        "미국 ETF 가격": [f"fmp:{symbol}" for symbol in ("SPY", "VOO", "QQQ", "QQQM", "IWM")],
        "국내 ETF·지수": ["krx:KOSPI200", "krx:KOSDAQ150", "krx:069500", "krx:229200", "krx:360750", "krx:133690"],
    }
    for label, ids in expected.items():
        if not any(item in present for item in ids):
            notes.append(f"{label} 데이터는 인증키 없이 수집하지 않았다. 수치를 만들지 않는다.")
    if not present:
        notes.append("저장된 관측값이 없다.")
    return notes
