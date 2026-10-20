from finance.catalog import ECOS_SERIES
from finance.http_client import HttpError
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, iso_date, parse_number

URL = "https://ecos.bok.or.kr/api/StatisticSearch/{key}/json/kr/{start}/{end}/{stat}/{cycle}/{date_from}/{date_to}/{item}"


class EcosSource:
    provider_id = "ecos"
    name = "한국은행 ECOS"

    def __init__(self, http, api_key=""):
        self.http = http
        self.api_key = api_key

    def instruments(self):
        return [
            {
                "instrument_id": f"ecos:{item['symbol']}",
                "provider_id": self.provider_id,
                "symbol": item["symbol"],
                "name": item["name"],
                "asset_class": item["asset_class"],
                "market": "KR",
                "currency": "KRW" if item["asset_class"] == "fx" else None,
                "unit": item["unit"],
                "price_kind": item["price_kind"],
                "frequency": "daily",
                "note": item["note"],
            }
            for item in ECOS_SERIES
        ]

    def check(self):
        if not self.api_key:
            return SourceResult(
                self.provider_id,
                issues=[SourceIssue(self.provider_id, "AUTH_REQUIRED", "ECOS_API_KEY가 없다.")],
                probed={"live": False},
            )
        return self._one(ECOS_SERIES[0], probe=True)

    def collect(self):
        result = SourceResult(self.provider_id)
        if not self.api_key:
            result.issues.append(SourceIssue(self.provider_id, "AUTH_REQUIRED", "ECOS_API_KEY가 없다."))
            return result
        for series in ECOS_SERIES:
            piece = self._one(series, probe=False)
            result.observations.extend(piece.observations)
            result.issues.extend(piece.issues)
        return result

    def _one(self, series, probe):
        result = SourceResult(self.provider_id)
        start = 1
        while True:
            url = URL.format(
                key=self.api_key,
                start=start,
                end=start + 99,
                stat=series["stat_code"],
                cycle=series["cycle"],
                date_from="19900101",
                date_to="29991231",
                item=series["item_code"],
            )
            try:
                payload = self.http.get_json(url)
            except HttpError as error:
                result.issues.append(
                    SourceIssue(self.provider_id, "HTTP_ERROR", str(error), f"ecos:{series['symbol']}")
                )
                return result
            rows = payload.get("StatisticSearch", {}).get("row", [])
            result_block = payload.get("RESULT")
            if result_block and not rows:
                result.issues.append(
                    SourceIssue(
                        self.provider_id,
                        result_block.get("CODE", "ECOS_ERROR"),
                        result_block.get("MESSAGE", "ECOS error"),
                        f"ecos:{series['symbol']}",
                    )
                )
                return result
            if probe:
                result.probed = {"live": bool(rows)}
                return result
            result.observations.extend(parse_ecos_rows(series, rows))
            if len(rows) < 100:
                return result
            start += 100


def parse_ecos_rows(series, rows):
    parsed = []
    for item in rows:
        raw_date = item.get("TIME", "")
        value = parse_number(item.get("DATA_VALUE"))
        if len(raw_date) != 8 or value is None:
            continue
        obs_date = iso_date(raw_date)
        parsed.append(
            Observation(
                instrument_id=f"ecos:{series['symbol']}",
                obs_date=obs_date,
                price_kind=series["price_kind"],
                close=value,
                available_at=available_at(obs_date, "daily", "KR"),
            )
        )
    return parsed
