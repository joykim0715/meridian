import assert from "node:assert/strict";
import test from "node:test";
import { classifySymbol, holdingReport, orderOpinion } from "./order-advice.mjs";

const board = {
  signals: { "cboe:VIX": "up", "fred:DGS10": "up", "fred:DEXKOUS": "down" },
  basket: [
    { name: "S&P500", stance: "scale", outlook: "불안이 커지는 중이다." },
    { name: "QQQ", stance: "pause", outlook: "금리가 오르는 중이다." },
    { name: "Vanguard", stance: "scale", outlook: "같은 지수다." },
    { name: "TIGER", stance: "scale", outlook: "원·달러가 내리는 중이다." },
    { name: "SCHD", stance: "pause", outlook: "배당수익률은 여기 없다." },
  ],
};

const rows = ["S&P500", "QQQ", "Vanguard", "TIGER", "SCHD"].map((name) => ({ name, qty: 0 }));

test("zero holdings talk about starting, not keeping a position", () => {
  const text = holdingReport(rows, board, {});
  assert.match(text, /모두 없다/);
  assert.match(text, /QQQ 보유 없음. 오늘은 새로 사지 않는다/);
  assert.match(text, /S&P500 보유 없음. 새로 산다면/);
  assert.doesNotMatch(text, /유지한다/);
});

test("kospi, kosdaq, index funds and other names all return an opinion", () => {
  assert.equal(classifySymbol("코스피").kind, "kospi");
  assert.equal(classifySymbol("코스닥150").kind, "kosdaq");
  assert.equal(classifySymbol("지수투자").kind, "index");
  assert.equal(classifySymbol("삼성전자").kind, "kr-name");
  assert.equal(classifySymbol("005930").kind, "kr-name");
  assert.equal(classifySymbol("AAPL").kind, "us-name");
  const kospi = orderOpinion("코스피", "buy", 10, board, {});
  assert.match(kospi, /오늘은 사지 않는다/);
  assert.match(kospi, /종가는 KRX 키가 없어/);
  assert.match(orderOpinion("코스닥", "buy", 4, board, {}), /10년 금리/);
  assert.match(orderOpinion("지수투자", "sell", 8, board, {}), /목표가는 말하지 않는다/);
  assert.match(orderOpinion("AAPL", "buy", 3, board, {}), /이 종목 가격은 여기 없다/);
  assert.match(orderOpinion("SHUD", "buy", 2, board, {}), /오늘은 사지 않는다/);
});
