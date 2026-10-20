from datetime import date, timedelta

from finance.catalog import KRX_ETFS, KRX_INDEXES
from finance.http_client import HttpError
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, business_days, iso_date, parse_number

LIVE_URL = "https://data-dbg.krx.co.kr/svc/apis/{endpoint}?basDd={day}"


class KrxSource:
    provider_id = "krx"
    name = "KRX Open API"

    def __init__(self, http, api_key="", mode="update", store=None, since=None, pause=lambda _seconds: None):
        self.http = http
        self.api_key = api_key
        self.mode = mode
        self.store = store
        self.since = since
        self.pause = pause

    def instruments(self):
        rows = []
        for item in KRX_INDEXES:
            rows.append(self._meta(item["symbol"], item["name"], "index"))
        for item in KRX_ETFS:
            rows.append(self._meta(item["symbol"], item["name"], "etf"))
        return rows

    def _meta(self, symbol, name, asset_class):
        return {
            "instrument_id": f"krx:{symbol}",
            "provider_id": self.provider_id,
            "symbol": symbol,
            "name": name,
            "asset_class": asset_class,
            "market": "KR",
            "currency": "KRW",
            "unit": "krw",
            "price_kind": "close",
            "frequency": "daily",
            "note": "KRX 일별 종가. 수정가격과 NAV를 같은 값으로 쓰지 않는다.",
        }

    def check(self):
        if not self.api_key:
            return SourceResult(
                self.provider_id,
                issues=[SourceIssue(self.provider_id, "AUTH_REQUIRED", "KRX_API_KEY가 없어 실데이터는 조회하지 않는다.")],
                constraints=["샘플 응답은 2020-04-14 고정 예시이며 시세로 저장하지 않는다."],
                probed={"live": False},
            )
        day = business_days((date.today() - timedelta(days=10)).isoformat(), date.today().isoformat())[-1]
        try:
            payload = self.http.get_json(
                LIVE_URL.format(endpoint="idx/kospi_dd_trd", day=day.replace("-", "")),
                headers={"AUTH_KEY": self.api_key},
            )
        except HttpError as error:
            return SourceResult(self.provider_id, issues=[SourceIssue(self.provider_id, "HTTP_ERROR", str(error))])
        return SourceResult(self.provider_id, probed={"live": "OutBlock_1" in payload})

    def collect(self):
        result = SourceResult(self.provider_id)
        if not self.api_key:
            result.issues.append(SourceIssue(self.provider_id, "AUTH_REQUIRED", "KRX_API_KEY가 없다."))
            return result
        for day in self._days():
            result.observations.extend(self._indexes(day, result))
            result.observations.extend(self._etfs(day, result))
            self.pause(0.2)
        return result

    def _days(self):
        end = date.today().isoformat()
        if self.since:
            start = self.since
        elif self.mode == "backfill":
            start = (date.today() - timedelta(days=365)).isoformat()
        else:
            start = (date.today() - timedelta(days=10)).isoformat()
        return business_days(start, end)

    def _indexes(self, day, result):
        rows = []
        for item in KRX_INDEXES:
            try:
                payload = self._live(item["endpoint"], day)
            except HttpError as error:
                result.issues.append(SourceIssue(self.provider_id, "HTTP_ERROR", str(error), f"krx:{item['symbol']}"))
                continue
            block = payload.get("OutBlock_1", [])
            if not block:
                continue
            matched = [row for row in block if row.get("IDX_NM") == item["name"]]
            if not matched:
                result.issues.append(
                    SourceIssue(self.provider_id, "INDEX_NOT_FOUND", f"{item['name']} 없음", f"krx:{item['symbol']}")
                )
                continue
            rows.append(index_observation(item["symbol"], matched[0]))
        return rows

    def _etfs(self, day, result):
        try:
            payload = self._live("etp/etf_bydd_trd", day)
        except HttpError as error:
            result.issues.append(SourceIssue(self.provider_id, "HTTP_ERROR", str(error), "krx:etf"))
            return []
        wanted = {item["symbol"]: item for item in KRX_ETFS}
        rows = []
        for raw in payload.get("OutBlock_1", []):
            symbol = str(raw.get("ISU_CD", "")).strip()
            if symbol in wanted:
                rows.append(etf_observation(symbol, raw))
        return rows

    def _live(self, endpoint, day):
        return self.http.get_json(
            LIVE_URL.format(endpoint=endpoint, day=day.replace("-", "")),
            headers={"AUTH_KEY": self.api_key},
        )


def index_observation(symbol, raw):
    obs_date = iso_date(raw["BAS_DD"])
    return Observation(
        instrument_id=f"krx:{symbol}",
        obs_date=obs_date,
        price_kind="close",
        open=parse_number(raw.get("OPNPRC_IDX")),
        high=parse_number(raw.get("HGPRC_IDX")),
        low=parse_number(raw.get("LWPRC_IDX")),
        close=parse_number(raw.get("CLSPRC_IDX")),
        volume=parse_number(raw.get("ACC_TRDVOL")),
        value=parse_number(raw.get("ACC_TRDVAL")),
        available_at=available_at(obs_date, "daily", "KR"),
    )


def etf_observation(symbol, raw):
    obs_date = iso_date(raw["BAS_DD"])
    return Observation(
        instrument_id=f"krx:{symbol}",
        obs_date=obs_date,
        price_kind="close",
        open=parse_number(raw.get("TDD_OPNPRC")),
        high=parse_number(raw.get("TDD_HGPRC")),
        low=parse_number(raw.get("TDD_LWPRC")),
        close=parse_number(raw.get("TDD_CLSPRC")),
        volume=parse_number(raw.get("ACC_TRDVOL")),
        value=parse_number(raw.get("ACC_TRDVAL")),
        available_at=available_at(obs_date, "daily", "KR"),
    )

