import json
from datetime import date, datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

SERIES = [
    {
        "id": "cboe:VIX",
        "label": "시장의 불안 정도",
        "hint": "높을수록 주가가 크게 흔들릴 수 있다는 예상입니다. 오르내린 방향이 아닙니다.",
        "frequency": "daily",
        "kind": "index",
        "hero": True,
    },
    {
        "id": "fred:DGS10",
        "label": "미국 10년 금리",
        "hint": "미국 장기 국채 금리입니다. 높을수록 돈을 빌리는 비용이 비쌉니다.",
        "frequency": "daily",
        "kind": "percent",
        "hero": True,
    },
    {
        "id": "fred:DCOILWTICO",
        "label": "WTI 원유",
        "hint": "배럴당 달러입니다. 중동 공급 차질이 물가와 금리로 이어지는지 확인하는 값입니다.",
        "frequency": "daily",
        "kind": "index",
        "hero": False,
    },
    {
        "id": "fred:DEXKOUS",
        "label": "원·달러 환율",
        "hint": "1달러를 사려면 필요한 원화입니다.",
        "frequency": "daily",
        "kind": "fx",
        "hero": True,
    },
    {
        "id": "fred:DGS2",
        "label": "미국 2년 금리",
        "hint": "미국 단기 국채 금리입니다.",
        "frequency": "daily",
        "kind": "percent",
        "hero": False,
    },
    {
        "id": "fred:T10Y2Y",
        "label": "장기금리와 단기금리 차이",
        "hint": "10년 금리에서 2년 금리를 뺀 값입니다.",
        "frequency": "daily",
        "kind": "percent",
        "hero": False,
    },
    {
        "id": "fred:BAMLH0A0HYM2",
        "label": "위험한 회사채 추가 금리",
        "hint": "위험한 회사채가 국채보다 얼마나 더 높은 금리를 주는가입니다.",
        "frequency": "daily",
        "kind": "percent",
        "hero": False,
    },
    {
        "id": "cboe:VIX9D",
        "label": "이번 주 불안 정도",
        "hint": "앞으로 9일 정도의 흔들림 예상입니다.",
        "frequency": "daily",
        "kind": "index",
        "hero": False,
    },
    {
        "id": "cboe:VVIX",
        "label": "불안 지수의 흔들림",
        "hint": "불안 정도 자체가 얼마나 출렁이는지입니다.",
        "frequency": "daily",
        "kind": "index",
        "hero": False,
    },
    {
        "id": "fred:DTWEXBGS",
        "label": "달러 세기",
        "hint": "달러가 다른 통화보다 센지 보여 줍니다.",
        "frequency": "daily",
        "kind": "index",
        "hero": False,
    },
    {
        "id": "fred:FEDFUNDS",
        "label": "미국 기준금리",
        "hint": "한 달 평균입니다. 오늘 바뀐 금리가 아닙니다.",
        "frequency": "monthly",
        "kind": "percent",
        "hero": False,
    },
    {
        "id": "fred:WALCL",
        "label": "연준이 가진 자산",
        "hint": "미국 중앙은행 자산 규모입니다. 일주일에 한 번 나옵니다.",
        "frequency": "weekly",
        "kind": "trillions",
        "hero": False,
    },
    {
        "id": "fred:USREC",
        "label": "미국 경기침체",
        "hint": "공식 판정입니다. 나중에 고쳐질 수 있어 오늘 신호로 쓰지 않습니다.",
        "frequency": "monthly",
        "kind": "flag",
        "hero": False,
    },
]


def last_completed_us_session(now):
    """미국 정규장 마감(한국시간 새벽 5시)이 지난 마지막 평일."""
    close_ready = now if now.hour >= 5 else now - timedelta(days=1)
    session = close_ready.date() - timedelta(days=1)
    while session.weekday() >= 5:
        session -= timedelta(days=1)
    return session


def freshness(frequency, obs_date, expected):
    gap = (expected - date.fromisoformat(obs_date)).days
    if frequency == "monthly":
        if gap <= 45:
            return "한 달에 한 번 나옵니다.", "monthly"
        return "월간 발표가 늦고 있습니다.", "stale"
    if frequency == "weekly":
        if gap <= 8:
            return "일주일에 한 번 나옵니다.", "weekly"
        return "주간 발표가 늦고 있습니다.", "stale"
    if gap <= 0:
        return "최근 미국장 마감입니다.", "current"
    if gap <= 3:
        return "공식 발표가 최근 마감보다 늦습니다.", "late"
    return "공식 자료가 이 날짜 이후로는 아직 없습니다.", "stale"


def format_value(kind, value):
    if kind == "percent":
        return f"{value:.2f}%"
    if kind == "fx":
        return f"{value:,.2f}원"
    if kind == "trillions":
        return f"{value / 1_000_000:.2f}조 달러"
    if kind == "flag":
        return "침체 아님" if value == 0 else "침체"
    return f"{value:.2f}"


def change_text(kind, delta):
    if abs(delta) < 1e-9:
        return "직전과 같음", "flat"
    direction = "up" if delta > 0 else "down"
    word = "높음" if direction == "up" else "낮음"
    amount = abs(delta)
    if kind == "percent":
        text = f"{amount:.2f}%포인트"
    elif kind == "fx":
        text = f"{amount:,.2f}원"
    elif kind == "trillions":
        text = f"{amount / 1_000_000:.2f}조 달러"
    elif kind == "flag":
        return "직전 달과 다름" if direction == "up" else "직전 달과 다름", direction
    else:
        text = f"{amount:.2f}"
    return f"직전보다 {text} {word}", direction


def trend_over(points, sessions=20):
    if len(points) < 2:
        return None
    sample = points[-(sessions + 1):]
    delta = sample[-1]["value"] - sample[0]["value"]
    if abs(delta) < 1e-6:
        direction = "flat"
    elif delta > 0:
        direction = "up"
    else:
        direction = "down"
    return {"direction": direction, "delta": delta, "sessions": len(sample) - 1, "points": sample}


def trend_phrase(kind, trend):
    if trend["direction"] == "flat":
        return f"최근 {trend['sessions']}거래일 거의 그대로", "flat"
    word = "높아짐" if trend["direction"] == "up" else "낮아짐"
    amount = abs(trend["delta"])
    if kind == "percent":
        text = f"{amount:.2f}%포인트"
    elif kind == "fx":
        text = f"{amount:,.2f}원"
    else:
        text = f"{amount:.2f}"
    return f"최근 {trend['sessions']}거래일 {text} {word}", trend["direction"]


def outlook_text(points):
    short = trend_over(points, 5)
    long = trend_over(points, 20)
    if not short or not long:
        return "다음 방향을 말할 자료가 부족하다.", "unknown"
    if short["direction"] == "flat" or long["direction"] == "flat":
        return "움직임이 작아 다음 방향은 보류한다.", "hold"
    if short["direction"] == long["direction"]:
        word = "높아지는" if long["direction"] == "up" else "낮아지는"
        return f"5일과 20일이 같다. 다음에도 {word} 흐름이 이어질 후보다. 확정은 아니다.", "continue"
    return "5일과 20일이 엇갈린다. 다음 방향은 보류한다.", "conflict"


def stance_for(name, vix, rate, fx):
    if name == "QQQ" and rate == "up" and vix == "up":
        return "pause"
    if name == "SCHD" and rate == "up":
        return "pause"
    if name in ("S&P500", "Vanguard") and vix == "flat":
        return "hold"
    if name in ("QQQ", "SCHD") and rate == "flat":
        return "hold"
    if name == "TIGER" and fx == "flat":
        return "hold"
    return "scale"


def investment_action(name, vix, rate, fx, fx_stale=False):
    if name == "S&P500":
        if vix == "up":
            return "불안이 커지는 중이다. 한 번에 사지 말고 오늘 넣을 돈의 일부만 산다."
        if vix == "down":
            return "불안이 줄어드는 중이다. 계획한 돈을 여러 번에 나눠 산다."
        return "불안이 거의 그대로다. 새로 서두르지 않는다."
    if name == "QQQ":
        if rate == "up" and vix == "up":
            return "금리와 불안이 같이 커진다. 오늘은 사지 않고 다음 수치를 본다."
        if rate == "up":
            return "금리가 오르는 중이다. S&P500보다 더 잘게 나눠 산다."
        if rate == "down":
            return "금리가 내리는 중이다. 그래도 한 번에 몰아서 사지 않는다."
        return "금리가 거의 그대로다. 나눠 살 계획만 유지한다."
    if name == "Vanguard":
        if vix == "up":
            return "S&P500과 같은 지수다. 둘을 합쳐 보고, 오늘은 일부만 산다."
        if vix == "down":
            return "S&P500과 같은 지수다. 이미 담은 금액과 겹치지 않게 나눠 산다."
        return "S&P500과 같은 지수다. 추가로 서두르지 않는다."
    if name == "TIGER":
        stale = "환율 발표가 최근 마감보다 늦다. " if fx_stale else ""
        if fx == "up":
            return stale + "원·달러가 오르는 중이다. 원화 부담이 커지니 더 잘게 나눠 산다."
        if fx == "down":
            return stale + "원·달러가 내리는 중이다. 계획한 돈을 나눠 산다."
        return stale + "환율이 거의 그대로다. 나눠 살 계획만 유지한다."
    if name == "SCHD":
        if rate == "up":
            return "금리가 오르는 중이다. 배당수익률은 여기 없다. 비교 전에는 일부만 산다."
        if rate == "down":
            return "금리가 내리는 중이다. 배당주에는 덜 불리하다. 그래도 나눠 산다."
        return "금리가 거의 그대로다. SCHD 가격은 여기 없으니 서두르지 않는다."
    return "판단할 지표가 없다. 사지 않고 기다린다."


BASKET = [
    {"name": "S&P500", "driver": "cboe:VIX", "because": "이 지수가 얼마나 흔들릴지 가장 바로 보여 준다."},
    {"name": "QQQ", "driver": "fred:DGS10", "because": "성장주 가격은 금리 변화에 가장 크게 움직인다."},
    {"name": "Vanguard", "driver": "cboe:VIX", "because": "S&P500과 같은 지수라 신호도 같다."},
    {"name": "TIGER", "driver": "fred:DEXKOUS", "because": "원화로 미국 주식을 살 때 환율이 바로 더해진다."},
    {"name": "SCHD", "driver": "fred:DGS10", "aka": "SHUD", "because": "배당과 채권 중 어디가 나은지는 이 금리가 가른다."},
]


def _clock_note(now):
    if now.hour < 5:
        return "지금 미국 장은 아직 안 끝났거나 주말입니다. 날짜는 마지막으로 끝난 거래일입니다."
    return "날짜가 오늘이 아니면, 그 지표의 공식 발표가 아직 그 날까지입니다."


def _basket(by_id):
    directions = {}
    for key in ("cboe:VIX", "fred:DGS10", "fred:DEXKOUS"):
        item = by_id.get(key)
        trend = trend_over(item["points"]) if item else None
        directions[key] = trend["direction"] if trend else "flat"
    cards = []
    for spec in BASKET:
        driver = by_id.get(spec["driver"])
        trend = trend_over(driver["points"]) if driver else None
        if not driver or not trend:
            cards.append({
                "name": spec["name"],
                "aka": spec.get("aka", ""),
                "driverLabel": "보는 지표 없음",
                "because": spec["because"],
                "valueLabel": "없음",
                "trendLabel": "추세를 계산할 수 없다",
                "direction": "flat",
                "outlook": "다음 방향을 말할 자료가 부족하다.",
                "outlookKind": "unknown",
                "stance": "pause",
                "dateLabel": "",
                "action": "판단할 수치가 없다. 사지 않고 기다린다.",
                "points": [],
            })
            continue
        phrase, direction = trend_phrase(_kind(spec["driver"]), trend)
        outlook, outlook_kind = outlook_text(driver["points"])
        fx_stale = spec["driver"] == "fred:DEXKOUS" and driver["freshnessKind"] == "stale"
        vix = directions["cboe:VIX"]
        rate = directions["fred:DGS10"]
        fx = directions["fred:DEXKOUS"]
        cards.append({
            "name": spec["name"],
            "aka": spec.get("aka", ""),
            "driverLabel": driver["label"],
            "because": spec["because"],
            "valueLabel": driver["valueLabel"],
            "trendLabel": phrase,
            "direction": direction,
            "outlook": outlook,
            "outlookKind": outlook_kind,
            "stance": stance_for(spec["name"], vix, rate, fx),
            "dateLabel": driver["dateLabel"],
            "freshness": driver["freshness"],
            "action": investment_action(spec["name"], vix, rate, fx, fx_stale),
            "points": trend["points"],
        })
    return cards


def _signal(by_id, instrument_id):
    item = by_id.get(instrument_id)
    trend = trend_over(item["points"]) if item else None
    return trend["direction"] if trend else "missing"


def _kind(instrument_id):
    for spec in SERIES:
        if spec["id"] == instrument_id:
            return spec["kind"]
    return "index"


def build_board(store, now=None):
    now = now or datetime.now(KST)
    expected = last_completed_us_session(now)
    heroes = []
    rows = []
    for spec in SERIES:
        points = _points(store, spec["id"])
        if len(points) < 1:
            continue
        latest = points[-1]
        previous = points[-2]["value"] if len(points) > 1 else None
        delta = None if previous is None or spec["kind"] == "flag" else latest["value"] - previous
        change_label, direction = ("비교할 직전 값이 없음", "flat") if delta is None else change_text(spec["kind"], delta)
        if spec["kind"] == "flag" and previous is not None:
            change_label, direction = change_text(spec["kind"], latest["value"] - previous)
        status, status_kind = freshness(spec["frequency"], latest["date"], expected)
        item = {
            "id": spec["id"],
            "label": spec["label"],
            "hint": spec["hint"],
            "valueLabel": format_value(spec["kind"], latest["value"]),
            "date": latest["date"],
            "dateLabel": _korean_date(latest["date"]),
            "changeLabel": change_label,
            "direction": direction,
            "freshness": status,
            "freshnessKind": status_kind,
            "points": points[-60:],
        }
        rows.append(item)
        if spec["hero"]:
            heroes.append(item)
    by_id = {item["id"]: item for item in rows}
    return {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "expectedSession": expected.isoformat(),
        "clockNote": _clock_note(now),
        "basket": _basket(by_id),
        "signals": {spec["id"]: _signal(by_id, spec["id"]) for spec in SERIES},
        "heroes": heroes,
        "rows": rows,
        "missing": [
            "미국 ETF 가격은 아직 연결되지 않았습니다.",
            "한국 ETF와 한국 지수 가격은 아직 연결되지 않았습니다.",
        ],
    }


def write_board(store, path, now=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_board(store, now)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def _points(store, instrument_id):
    rows = []
    for row in store.observations(instrument_id):
        if row["close"] is None or row["vintage_date"]:
            continue
        rows.append({"date": row["obs_date"], "value": row["close"]})
    return rows


def _korean_date(iso):
    year, month, day = iso.split("-")
    return f"{int(year)}년 {int(month)}월 {int(day)}일"
