const BASKET_ALIAS = {
  "S&P500": "S&P500",
  SP500: "S&P500",
  SPY: "S&P500",
  VOO: "S&P500",
  IVV: "S&P500",
  SPLG: "S&P500",
  VANGUARD: "Vanguard",
  QQQ: "QQQ",
  QQQM: "QQQ",
  SCHD: "SCHD",
  SHUD: "SCHD",
  TIGER: "TIGER",
};

function compact(raw) {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

function signal(board, id) {
  const value = board && board.signals ? board.signals[id] : "";
  return value || "missing";
}

function cardOf(board, name) {
  return ((board && board.basket) || []).find((item) => item.name === name) || null;
}

export function classifySymbol(raw) {
  const text = String(raw || "").trim();
  const key = compact(text);
  if (!key) return { kind: "empty", label: "" };
  if (BASKET_ALIAS[key]) return { kind: "basket", name: BASKET_ALIAS[key], label: text };
  if (/133690|나스닥|NASDAQ|QQQ/.test(key)) return { kind: "basket", name: "QQQ", label: text };
  if (/360750|미국S&P|미국SP|GSPC|S&P500|SP500/.test(key)) return { kind: "basket", name: "S&P500", label: text };
  if (/KOSDAQ|코스닥|229200|KQ11/.test(key)) return { kind: "kosdaq", label: text };
  if (/KOSPI|코스피|069500|KS11|KODEX200/.test(key)) return { kind: "kospi", label: text };
  if (/지수투자|인덱스|INDEX/.test(key) || text.includes("지수")) return { kind: "index", label: text };
  if (/[가-힣]/.test(text) || /^\d{6}$/.test(key)) return { kind: "kr-name", label: text };
  if (/^[A-Z][A-Z0-9.\-]{0,12}$/.test(key)) return { kind: "us-name", label: text };
  return { kind: "other", label: text };
}

function stanceFor(kind, board) {
  const vix = signal(board, "cboe:VIX");
  const rate = signal(board, "fred:DGS10");
  if (kind === "kosdaq") {
    if (rate === "up" && vix === "up") return "pause";
    if (rate === "flat" || rate === "missing") return "hold";
    return "scale";
  }
  if (vix === "up") return "pause";
  if (vix === "down") return "scale";
  if (vix === "flat" || vix === "missing") return "hold";
  return "hold";
}

function contextFor(kind, board) {
  const vix = signal(board, "cboe:VIX");
  const rate = signal(board, "fred:DGS10");
  const fx = signal(board, "fred:DEXKOUS");
  const fxNote = fx === "up" ? " 원·달러 20거래일도 높아지는 중이다." : fx === "down" ? " 원·달러 20거래일은 낮아지는 중이다." : "";
  if (kind === "kospi") {
    return "코스피 종가는 KRX 키가 없어 여기 없다. 국내 지수는 Cboe VIX와 원·달러로 본다." + fxNote + " " + directionPhrase("Cboe VIX", vix);
  }
  if (kind === "kosdaq") {
    return "코스닥 종가는 여기 없다. 성장 쪽이라 미국 10년 금리와 Cboe VIX로 본다." + fxNote + " " + directionPhrase("미국 10년 금리", rate);
  }
  if (kind === "index") {
    return "어느 지수인지 적혀 있지 않다. 시장 전체 불안인 Cboe VIX로 본다. " + directionPhrase("Cboe VIX", vix);
  }
  if (kind === "kr-name") {
    return "이 한국 종목 가격은 여기 없다. 코스피에 연결된 Cboe VIX로 본다." + fxNote + " " + directionPhrase("Cboe VIX", vix);
  }
  if (kind === "us-name") {
    return "이 종목 가격은 여기 없다. 미국 주식 전반은 Cboe VIX로 본다. " + directionPhrase("Cboe VIX", vix);
  }
  return "이 이름에 해당하는 가격은 여기 없다. 주식으로 보고 Cboe VIX만 말한다. " + directionPhrase("Cboe VIX", vix);
}

function directionPhrase(label, direction) {
  if (direction === "up") return label + " 20거래일은 높아지는 중이다.";
  if (direction === "down") return label + " 20거래일은 낮아지는 중이다.";
  if (direction === "flat") return label + " 20거래일 움직임이 작다.";
  return label + " 공식 수치가 없다.";
}

function newsText(name, newsByName) {
  const lines = newsByName && newsByName[name] ? newsByName[name] : [];
  return lines.length ? " " + lines.join(" ") : "";
}

function emptyPosition(stance) {
  if (stance === "pause") return "보유 없음. 오늘은 새로 사지 않는다.";
  if (stance === "hold") return "보유 없음. 새로 서두르지 않는다.";
  return "보유 없음. 새로 산다면 계획 수량을 한 번에 넣지 않는다.";
}

function heldPosition(name, qty, stance) {
  if (stance === "pause") return "보유 " + qty + "주는 유지한다. 오늘은 더 사지 않는다. 전량 매도 신호는 아니다.";
  if (stance === "hold") return "보유 " + qty + "주는 그대로 둔다.";
  const cap = Math.max(1, Math.round(qty / 4));
  return "보유 " + qty + "주. 속도 제한은 " + cap + "주다. 이 숫자는 시세의 정답이 아니다.";
}

export function holdingReport(rows, board, newsByName) {
  const lines = rows.map((row) => {
    if (row.qty === null) return row.name + ": 주수는 0 이상의 정수만 받는다.";
    const card = cardOf(board, row.name);
    const stance = card ? card.stance : "hold";
    const body = row.qty === 0 ? emptyPosition(stance) : heldPosition(row.name, row.qty, stance);
    return row.name + " " + body + newsText(row.name, newsByName);
  });
  if (rows.length > 0 && rows.every((row) => row.qty === 0)) {
    return "다섯 종목 보유가 모두 없다. 유지할 물량이 없으니 새로 넣을지만 말한다. " + lines.join(" ");
  }
  return lines.join(" ");
}

function tradeLine(label, side, qty, stance, outlook) {
  const cap = Math.max(1, Math.round(qty / (side === "sell" ? 2 : 4)));
  if (side === "sell") {
    return label + " " + qty + "주 매도. 목표가는 말하지 않는다. 한 번에 팔지 말고 " + cap + "주 이하만 줄인다. 이 절반은 속도 제한이다. " + outlook;
  }
  if (stance === "pause") return label + " " + qty + "주 매수. 오늘은 사지 않는다. " + outlook;
  if (stance === "hold") return label + " " + qty + "주 매수. 서두르지 않고 다음 수치를 본다. " + outlook;
  return label + " " + qty + "주 매수. 한 번에 사지 말고 " + cap + "주 이하로 나눠 산다. 이 비율은 속도 제한이다. " + outlook;
}

export function orderOpinion(raw, side, qty, board, newsByName) {
  if (!Number.isInteger(qty) || qty < 1) return "주수는 1 이상의 정수만 받는다.";
  const found = classifySymbol(raw);
  if (found.kind === "empty") return "종목이나 지수 이름을 입력한다.";
  if (found.kind === "basket") {
    const card = cardOf(board, found.name);
    if (!card) return found.label + " 지표가 없어 의견을 보류한다.";
    return tradeLine(found.label, side, qty, card.stance, (card.outlook || "") + newsText(found.name, newsByName));
  }
  const stance = stanceFor(found.kind, board);
  return tradeLine(found.label, side, qty, stance, contextFor(found.kind, board));
}
