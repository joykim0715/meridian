const BOARD_URL = "https://www.sbhnews.com/api/market";
const MACRO_URL = "https://www.sbhnews.com/api/macro";
const RATES_URL = "https://www.sbhnews.com/api/markets/policy-rates";
const CALENDAR_URL = "https://www.sbhnews.com/api/markets/econ-calendar";

function seoulStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}`;
}

function round(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function pctLabel(value) {
  const number = round(value, 2);
  if (number == null) return "";
  return `${number > 0 ? "+" : ""}${number}%`;
}

function pointLabel(value) {
  const number = round(value, 3);
  if (number == null) return "";
  return `${number > 0 ? "+" : ""}${number}`;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function boardQuote(rows, symbol) {
  const item = rows.find((row) => row.symbol === symbol);
  if (!item) return null;
  return {
    symbol: item.symbol,
    label: item.label,
    price: round(item.price, 2),
    change: round(item.change, 2),
    changeLabel: pointLabel(item.change),
    changePct: round(item.changePct, 2),
    changePctLabel: pctLabel(item.changePct),
  };
}

function macroLevel(item, priceDigits) {
  return {
    id: item.id,
    label: item.label,
    price: round(item.price, priceDigits),
    change: round(item.change, 3),
    changeLabel: pointLabel(item.change),
    changePct: round(item.changePct, 2),
    changePctLabel: pctLabel(item.changePct),
    unit: item.unit || "",
  };
}

function latestEvent(items, series, nowMs) {
  return items
    .filter((item) => item.series === series && Date.parse(item.releaseAt) <= nowMs)
    .filter((item) => (item.values || []).some((value) => typeof value.actual === "number"))
    .sort((a, b) => Date.parse(b.releaseAt) - Date.parse(a.releaseAt))[0] || null;
}

function eventValue(event, includes) {
  if (!event) return null;
  const found = (event.values || []).find((value) => (
    includes.every((part) => String(value.label).includes(part)) && typeof value.actual === "number"
  ));
  if (!found) return null;
  return {
    label: found.label,
    actual: found.actual,
    previous: typeof found.previous === "number" ? found.previous : null,
  };
}

function cpiRow(key, label, event, primary, extra) {
  if (!event || !primary) return null;
  return {
    key,
    label,
    title: event.title,
    releaseAt: event.releaseAt,
    value: primary.actual,
    previous: primary.previous,
    unit: "%",
    detail: primary.label,
    extra: extra ? `${extra.label} ${extra.actual} (이전 ${extra.previous ?? "없음"})` : "",
  };
}

export async function loadMarketSnapshot(now = new Date()) {
  const [board, macro, rates] = await Promise.all([
    getJson(BOARD_URL),
    getJson(MACRO_URL),
    getJson(RATES_URL),
  ]);
  if (!Array.isArray(board) || board.length === 0) throw new Error("market board empty");
  if (!Array.isArray(macro?.yields) || !Array.isArray(macro?.markets)) throw new Error("macro payload incomplete");
  if (!Array.isArray(rates?.rates)) throw new Error("policy rates missing");

  let calendar = [];
  try {
    const loaded = await getJson(CALENDAR_URL);
    if (Array.isArray(loaded)) calendar = loaded;
  } catch {
    calendar = [];
  }

  const nowMs = now.getTime();
  const gspc = boardQuote(board, "^GSPC");
  const ixic = boardQuote(board, "^IXIC");
  const krw = boardQuote(board, "KRW=X");
  if (!gspc || !ixic || !krw) throw new Error("dashboard missing S&P500, NASDAQ, or USD/KRW");

  const vix = (macro.markets || []).find((item) => item.id === "vix");
  const dollar = (macro.markets || []).find((item) => item.id === "dollar-index");
  if (!vix || !dollar) throw new Error("dashboard missing VIX or dollar index");

  const usCpi = latestEvent(calendar, "us-cpi", nowMs);
  const krCpi = latestEvent(calendar, "kr-cpi", nowMs);
  const euCpi = latestEvent(calendar, "eu-cpi", nowMs);
  const jpCpi = latestEvent(calendar, "jp-cpi", nowMs);
  const cpi = [
    cpiRow("us", "미국", usCpi, eventValue(usCpi, ["헤드라인", "YoY"]), eventValue(usCpi, ["근원", "YoY"])),
    cpiRow("kr", "한국", krCpi, eventValue(krCpi, ["YoY"]), null),
    cpiRow("eu", "유로존", euCpi, eventValue(euCpi, ["YoY"]), null),
    cpiRow("jp", "일본", jpCpi, eventValue(jpCpi, ["전국", "YoY"]), null),
  ].filter(Boolean);

  const extraCommodities = (macro.commodities || [])
    .filter((item) => item.id === "natural-gas" || item.id === "wheat")
    .map((item) => macroLevel(item, 3));
  const yuan = (macro.fx || []).find((item) => item.id === "usd-cny");

  return {
    source: "https://www.sbhnews.com/markets",
    fetchedAt: seoulStamp(now),
    fieldNotes: {
      change: "직전 값 대비 절대 변화. 국채는 %포인트, 지수는 포인트, 환율과 원자재는 해당 가격 단위.",
      changePct: "직전 값 대비 상대 변화율. 국채의 changePct는 %포인트가 아니다.",
      policyPrevious: "정책금리 previous는 이번 결정 직전 수준이다. 오늘 하루의 변화가 아니다.",
      cpiPrevious: "CPI previous는 직전 발표치다.",
    },
    priority: ["ETF 투자 동향", "핵심 경제 지표", "채권 동향"],
    basket: [
      {
        name: "S&P500",
        holds: "미국 대형주 지수",
        quote: gspc,
        limit: "이 지수 값만 쓴다.",
      },
      {
        name: "QQQ",
        holds: "나스닥100 ETF",
        quote: ixic,
        quoteMeaning: "대시보드의 나스닥 종합(^IXIC)이다. QQQ 가격이 아니고 나스닥100도 아니다.",
        limit: "QQQ 가격과 나스닥100 등락은 쓰지 않는다.",
      },
      {
        name: "Vanguard",
        holds: "S&P500을 추종하는 ETF",
        quote: gspc,
        limit: "S&P500과 같은 지수다. 별도 가격을 만들지 않는다.",
      },
      {
        name: "TIGER",
        holds: "한국에 상장된 미국 지수 ETF",
        quotes: {
          sp500: gspc,
          nasdaqComposite: ixic,
          usdKrw: krw,
        },
        limit: "기초지수와 달러/원만 쓴다. TIGER 시세, 괴리율, 환헤지 여부, 분배금은 없다.",
      },
      {
        name: "SCHD",
        holds: "미국 배당주 ETF. 사용자가 적은 SHUD는 이 종목으로 본다.",
        quote: null,
        limit: "가격, 배당수익률, 구성 종목은 없다. 정책금리, 국채금리, VIX, S&P500 환경만 말한다.",
      },
    ],
    volatility: macroLevel(vix, 2),
    dollarIndex: macroLevel(dollar, 2),
    otherIndices: ["^DJI", "^KS11", "^N225", "^HSI", "000001.SS"].map((symbol) => boardQuote(board, symbol)).filter(Boolean),
    fx: [krw, boardQuote(board, "EURUSD=X"), boardQuote(board, "USDJPY=X"), yuan ? macroLevel(yuan, 4) : null].filter(Boolean),
    commodities: [
      boardQuote(board, "CL=F"),
      boardQuote(board, "BZ=F"),
      boardQuote(board, "GC=F"),
      ...extraCommodities,
    ].filter(Boolean),
    yields: (macro.yields || []).map((item) => ({
      id: item.id,
      label: item.label,
      yieldPct: round(item.price, 3),
      dayChangePctPoint: round(item.change, 3),
      dayChangePctPointLabel: pointLabel(item.change),
      dayChangePct: round(item.changePct, 2),
      dayChangePctLabel: pctLabel(item.changePct),
    })),
    policyRates: rates.rates.map((rate) => ({
      key: rate.key,
      label: rate.label,
      value: rate.value,
      previous: rate.prev,
      unit: rate.unit || "%",
      asOf: rate.asOf,
      note: rate.note || "",
    })),
    cpi,
  };
}
