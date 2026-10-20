from finance.catalog import KRX_ETFS, US_ETFS
from finance.http_client import HttpError
from finance.models import Observation, SourceIssue, SourceResult
from finance.sources.calendar import available_at, iso_date, parse_number

DEFAULT_BASE = "https://openapi.koreainvestment.com:9443"
DOMESTIC_PATH = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
OVERSEAS_PATH = "/uapi/overseas-price/v1/quotations/dailyprice"
DOMESTIC_TR = "FHKST03010100"
OVERSEAS_TR = "HHDFS76240000"
QUOTE_TR_IDS = {DOMESTIC_TR, OVERSEAS_TR}


class KisSource:
    """시세 조회만 사용한다. 주문 TR ID는 포함하지 않는다."""

    provider_id = "kis"
    name = "Korea Investment Open API"

    def __init__(self, http, app_key="", app_secret="", base_url=DEFAULT_BASE):
        self.http = http
        self.app_key = app_key
        self.app_secret = app_secret
        self.base_url = base_url.rstrip("/")
        self.token = None

    def instruments(self):
        rows = []
        for item in KRX_ETFS:
            rows.append(self._meta(item["symbol"], item["name"], "KR", "KRW"))
        for item in US_ETFS:
            rows.append(self._meta(item["symbol"], item["name"], "US", "USD"))
        return rows

    def _meta(self, symbol, name, market, currency):
        return {
            "instrument_id": f"kis:{symbol}",
            "provider_id": self.provider_id,
            "symbol": symbol,
            "name": name,
            "asset_class": "etf",
            "market": market,
            "currency": currency,
            "unit": currency.lower(),
            "price_kind": "adjusted_close",
            "frequency": "daily",
            "note": "KIS 일별시세. MODP 0은 수정주가, 1은 원주가. 주문 API는 사용하지 않는다.",
        }

    def check(self):
        if not self.app_key or not self.app_secret:
            return SourceResult(
                self.provider_id,
                issues=[SourceIssue(self.provider_id, "AUTH_REQUIRED", "KIS_APP_KEY 또는 KIS_APP_SECRET이 없다.")],
                probed={"live": False},
            )
        try:
            self._token()
        except HttpError as error:
            return SourceResult(self.provider_id, issues=[SourceIssue(self.provider_id, "HTTP_ERROR", str(error))])
        return SourceResult(self.provider_id, probed={"token": True})

    def collect(self):
        result = SourceResult(self.provider_id, constraints=["주문 API는 호출하지 않는다."])
        if not self.app_key or not self.app_secret:
            result.issues.append(SourceIssue(self.provider_id, "AUTH_REQUIRED", "KIS 인증값이 없다."))
            return result
        try:
            self._token()
        except HttpError as error:
            result.issues.append(SourceIssue(self.provider_id, "HTTP_ERROR", str(error)))
            return result
        for item in KRX_ETFS:
            result.observations.extend(self._domestic(item["symbol"], result))
        for item in US_ETFS:
            result.observations.extend(self._overseas(item, result))
        return result

    def _token(self):
        if self.token:
            return self.token
        payload = self.http.post_json(
            f"{self.base_url}/oauth2/tokenP",
            {"grant_type": "client_credentials", "appkey": self.app_key, "appsecret": self.app_secret},
        )
        self.token = payload["access_token"]
        return self.token

    def _headers(self, tr_id):
        if tr_id not in QUOTE_TR_IDS:
            raise HttpError(0, "quote tr_id only")
        return {
            "authorization": f"Bearer {self._token()}",
            "appkey": self.app_key,
            "appsecret": self.app_secret,
            "tr_id": tr_id,
        }

    def _domestic(self, symbol, result):
        query = (
            f"{self.base_url}{DOMESTIC_PATH}?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD={symbol}"
            "&FID_INPUT_DATE_1=19900101&FID_INPUT_DATE_2=29991231&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0"
        )
        try:
            payload = self.http.get_json(query, headers=self._headers(DOMESTIC_TR))
        except HttpError as error:
            result.issues.append(SourceIssue(self.provider_id, "HTTP_ERROR", str(error), f"kis:{symbol}"))
            return []
        return parse_kis_daily(symbol, payload.get("output2", []), "KR")

    def _overseas(self, item, result):
        query = (
            f"{self.base_url}{OVERSEAS_PATH}?AUTH=&EXCD={item['exchange']}&SYMB={item['symbol']}"
            "&GUBN=0&BYMD=&MODP=0"
        )
        try:
            payload = self.http.get_json(query, headers=self._headers(OVERSEAS_TR))
        except HttpError as error:
            result.issues.append(SourceIssue(self.provider_id, "HTTP_ERROR", str(error), f"kis:{item['symbol']}"))
            return []
        return parse_kis_daily(item["symbol"], payload.get("output2", []), "US")


def parse_kis_daily(symbol, rows, market):
    parsed = []
    for item in rows:
        raw_date = item.get("stck_bsop_date") or item.get("xymd")
        close = parse_number(item.get("stck_clpr") or item.get("clos"))
        if not raw_date or close is None:
            continue
        obs_date = iso_date(raw_date)
        parsed.append(
            Observation(
                instrument_id=f"kis:{symbol}",
                obs_date=obs_date,
                price_kind="adjusted_close",
                open=parse_number(item.get("stck_oprc") or item.get("open")),
                high=parse_number(item.get("stck_hgpr") or item.get("high")),
                low=parse_number(item.get("stck_lwpr") or item.get("low")),
                close=close,
                adjusted_close=close,
                volume=parse_number(item.get("acml_vol") or item.get("tvol")),
                available_at=available_at(obs_date, "daily", market),
            )
        )
    return parsed
