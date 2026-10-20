import csv
import io

from finance.catalog import CBOE_SERIES
from finance.http_client import HttpError, redact
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, iso_date, parse_number

BASE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/"


class CboeSource:
    provider_id = "cboe"
    name = "Cboe"

    def __init__(self, http):
        self.http = http

    def instruments(self):
        return [
            {
                "instrument_id": f"cboe:{series['symbol']}",
                "provider_id": self.provider_id,
                "symbol": series["symbol"],
                "name": series["name"],
                "asset_class": "volatility",
                "market": "US",
                "currency": None,
                "unit": "index",
                "price_kind": "ohlcv" if series["layout"] == "ohlc" else "level",
                "frequency": "daily",
                "note": series["note"],
            }
            for series in CBOE_SERIES
        ]

    def check(self):
        series = CBOE_SERIES[0]
        try:
            text = self.http.get_text(BASE_URL + series["file"])
        except HttpError as error:
            return SourceResult(self.provider_id, issues=[SourceIssue(self.provider_id, "HTTP_ERROR", str(error))])
        return SourceResult(
            self.provider_id,
            constraints=["공식 일별 CSV 전체 파일이다. 날짜 조건 증분 API는 없다."],
            probed={"csv": text.splitlines()[0].startswith("DATE")},
        )

    def collect(self):
        result = SourceResult(
            self.provider_id,
            constraints=["Cboe VIX와 FRED VIXCLS는 서로 다른 시계열이다. 합치지 않는다."],
        )
        for series in CBOE_SERIES:
            try:
                text = self.http.get_text(BASE_URL + series["file"])
                result.observations.extend(parse_cboe_csv(text, series))
            except Exception as error:
                result.issues.append(
                    SourceIssue(self.provider_id, "FETCH_FAILED", redact(error), f"cboe:{series['symbol']}")
                )
        return result


def parse_cboe_csv(text, series):
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "DATE" not in reader.fieldnames:
        raise HttpError(200, "Cboe CSV header missing")
    rows = []
    price_kind = "ohlcv" if series["layout"] == "ohlc" else "level"
    for item in reader:
        obs_date = iso_date(item["DATE"])
        if series["layout"] == "ohlc":
            row = Observation(
                instrument_id=f"cboe:{series['symbol']}",
                obs_date=obs_date,
                price_kind=price_kind,
                open=parse_number(item["OPEN"]),
                high=parse_number(item["HIGH"]),
                low=parse_number(item["LOW"]),
                close=parse_number(item["CLOSE"]),
                available_at=available_at(obs_date, "daily", "US"),
            )
        else:
            close_key = series["symbol"] if series["symbol"] in item else "CLOSE"
            row = Observation(
                instrument_id=f"cboe:{series['symbol']}",
                obs_date=obs_date,
                price_kind=price_kind,
                close=parse_number(item[close_key]),
                available_at=available_at(obs_date, "daily", "US"),
            )
        if row.close is None:
            continue
        rows.append(row)
    return rows
