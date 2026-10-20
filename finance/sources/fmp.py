from finance.catalog import US_ETFS
from finance.http_client import HttpError
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, parse_number

QUOTE_URL = "https://financialmodelingprep.com/stable/quote?symbol={symbol}&apikey={key}"
HISTORY_URL = "https://financialmodelingprep.com/stable/historical-price-eod/full?symbol={symbol}&apikey={key}"


class FmpSource:
    provider_id = "fmp"
    name = "Financial Modeling Prep"

    def __init__(self, http, api_key="", mode="update"):
        self.http = http
        self.api_key = api_key
        self.mode = mode

    def instruments(self):
        return [
            {
                "instrument_id": f"fmp:{item['symbol']}",
                "provider_id": self.provider_id,
                "symbol": item["symbol"],
                "name": item["name"],
                "asset_class": "etf",
                "market": "US",
                "currency": "USD",
                "unit": "usd",
                "price_kind": "ohlcv",
                "frequency": "daily",
                "note": "FMP EOD. 수정종가와 일반 종가를 구분해 저장한다.",
            }
            for item in US_ETFS
        ]

    def check(self):
        if not self.api_key:
            return SourceResult(
                self.provider_id,
                issues=[SourceIssue(self.provider_id, "AUTH_REQUIRED", "FMP_API_KEY가 없다. 키 없는 호출은 401이다.")],
                probed={"live": False},
            )
        try:
            payload = self.http.get_json(QUOTE_URL.format(symbol="SPY", key=self.api_key))
        except HttpError as error:
            return SourceResult(self.provider_id, issues=[SourceIssue(self.provider_id, "HTTP_ERROR", str(error))])
        return SourceResult(self.provider_id, probed={"live": isinstance(payload, list)})

    def collect(self):
        result = SourceResult(self.provider_id)
        if not self.api_key:
            result.issues.append(SourceIssue(self.provider_id, "AUTH_REQUIRED", "FMP_API_KEY가 없다."))
            return result
        for item in US_ETFS:
            try:
                payload = self.http.get_json(HISTORY_URL.format(symbol=item["symbol"], key=self.api_key))
                result.observations.extend(parse_fmp_history(item["symbol"], payload))
            except HttpError as error:
                result.issues.append(
                    SourceIssue(self.provider_id, "HTTP_ERROR", str(error), f"fmp:{item['symbol']}")
                )
        return result


def parse_fmp_history(symbol, payload):
    rows = payload if isinstance(payload, list) else payload.get("historical", [])
    parsed = []
    for item in rows:
        obs_date = item.get("date")
        close = parse_number(item.get("close"))
        if not obs_date or close is None:
            continue
        parsed.append(
            Observation(
                instrument_id=f"fmp:{symbol}",
                obs_date=obs_date,
                price_kind="ohlcv",
                open=parse_number(item.get("open")),
                high=parse_number(item.get("high")),
                low=parse_number(item.get("low")),
                close=close,
                adjusted_close=parse_number(item.get("adjClose") or item.get("adjustedClose")),
                volume=parse_number(item.get("volume")),
                available_at=available_at(obs_date, "daily", "US"),
            )
        )
    return parsed
