from finance.catalog import FRED_SERIES
from finance.http_client import HttpError, redact
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, iso_date, parse_number, shift_days

CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={symbol}&cosd={start}"
API_URL = "https://api.stlouisfed.org/fred/series/observations"


class FredSource:
    provider_id = "fred"
    name = "FRED"

    def __init__(self, http, api_key="", store=None, mode="update"):
        self.http = http
        self.api_key = api_key
        self.store = store
        self.mode = mode

    def instruments(self):
        rows = []
        for series in FRED_SERIES:
            rows.append(
                {
                    "instrument_id": f"fred:{series['symbol']}",
                    "provider_id": self.provider_id,
                    "symbol": series["symbol"],
                    "name": series["name"],
                    "asset_class": series["asset_class"],
                    "market": series["market"],
                    "currency": series["currency"],
                    "unit": series["unit"],
                    "price_kind": series["price_kind"],
                    "frequency": series["frequency"],
                    "note": series["note"],
                }
            )
        return rows

    def check(self):
        series = FRED_SERIES[0]
        try:
            text = self.http.get_text(CSV_URL.format(symbol=series["symbol"], start="2026-01-01"))
        except HttpError as error:
            return SourceResult(
                self.provider_id,
                issues=[SourceIssue(self.provider_id, "HTTP_ERROR", str(error))],
                probed={"csv": False},
            )
        header_ok = text.startswith("observation_date")
        api_state = "not_configured"
        if self.api_key:
            try:
                payload = self.http.get_json(
                    API_URL + f"?series_id=VIXCLS&api_key={self.api_key}&file_type=json&limit=1&sort_order=desc"
                )
                api_state = "ok" if payload.get("observations") else "unexpected"
            except HttpError as error:
                api_state = f"error:{error.status}"
        return SourceResult(
            self.provider_id,
            constraints=["공개 CSV는 최신 수정본만 제공한다. 발표 당시 값은 FRED_API_KEY가 있을 때만 저장한다."],
            probed={"csv": header_ok, "api": api_state},
        )

    def collect(self):
        result = SourceResult(
            self.provider_id,
            constraints=["공개 CSV는 최신 수정본만 제공한다. vintage_date는 비어 있다."],
        )
        if not self.api_key:
            result.issues.append(
                SourceIssue(self.provider_id, "API_KEY_ABSENT", "FRED JSON API는 키가 없어 빈티지를 저장하지 않는다.")
            )
        for series in FRED_SERIES:
            instrument_id = f"fred:{series['symbol']}"
            start = series["start"]
            if self.mode == "update" and self.store is not None:
                latest = self.store.latest_date(instrument_id)
                if latest:
                    start = shift_days(latest, -14)
            try:
                text = self.http.get_text(CSV_URL.format(symbol=series["symbol"], start=start))
                result.observations.extend(parse_fred_csv(text, series))
            except Exception as error:
                result.issues.append(SourceIssue(self.provider_id, "FETCH_FAILED", redact(error), instrument_id))
            if self.api_key and self.mode == "backfill":
                try:
                    result.observations.extend(self._vintages(series, start))
                except HttpError as error:
                    result.issues.append(SourceIssue(self.provider_id, "VINTAGE_ERROR", str(error), instrument_id))
        return result

    def _vintages(self, series, start):
        payload = self.http.get_json(
            API_URL
            + f"?series_id={series['symbol']}&api_key={self.api_key}&file_type=json"
            + f"&observation_start={start}&realtime_start=1776-07-04"
        )
        rows = []
        for item in payload.get("observations", []):
            value = parse_number(item.get("value", ""))
            if value is None:
                continue
            obs_date = item["date"]
            vintage = item.get("realtime_start", "")
            rows.append(
                Observation(
                    instrument_id=f"fred:{series['symbol']}",
                    obs_date=obs_date,
                    price_kind=series["price_kind"],
                    close=value,
                    vintage_date=vintage,
                    available_at=f"{vintage}T00:00:00Z" if vintage else available_at(obs_date, series["frequency"], series["market"]),
                )
            )
        return rows


def parse_fred_csv(text, series):
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines or not lines[0].startswith("observation_date"):
        raise HttpError(200, "FRED CSV header missing")
    rows = []
    for line in lines[1:]:
        date_text, raw_value = line.split(",", 1)
        value = parse_number(raw_value)
        if value is None:
            continue
        obs_date = iso_date(date_text)
        rows.append(
            Observation(
                instrument_id=f"fred:{series['symbol']}",
                obs_date=obs_date,
                price_kind=series["price_kind"],
                close=value,
                available_at=available_at(obs_date, series["frequency"], series["market"]),
            )
        )
    return rows
