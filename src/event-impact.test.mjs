import assert from "node:assert/strict";
import test from "node:test";
import { assessImpact } from "./event-impact.mjs";

const markdown = `# 브리핑
## 오늘의 핵심 동향
### 1. 예멘 후티 미사일
- 핵심 내용: 후티가 미사일 6발을 쐈고 53명이 숨졌다.
- 향후 24~72시간 관찰 포인트: 추가 공격
## 제외된 기사
`;

test("matching risk and a rising VIX keeps the official stance", () => {
  const impact = assessImpact(markdown, { signals: { "cboe:VIX": "up", "fred:DCOILWTICO": "down", "fred:DEXKOUS": "down" } });
  assert.equal(impact.issues.length, 1);
  assert.match(impact.byName["S&P500"][0], /같은 방향/);
  assert.match(impact.byName.QQQ[0], /반대/);
  assert.equal(impact.byName.TIGER, undefined);
});

test("a late oil print does not change the share count", () => {
  const impact = assessImpact(markdown, {
    signals: { "cboe:VIX": "up", "fred:DCOILWTICO": "down" },
    rows: [{ id: "fred:DCOILWTICO", freshnessKind: "stale" }],
  });
  assert.match(impact.byName.QQQ[0], /발표가 최근 마감보다 늦어/);
});

test("a falling official series does not let the headline change the share count", () => {
  const impact = assessImpact(markdown, { signals: { "cboe:VIX": "down", "fred:DCOILWTICO": "missing" } });
  assert.match(impact.byName["S&P500"][0], /뉴스만으로 바꾸지 않고/);
  assert.match(impact.byName.QQQ[0], /공식 수치가 없어/);
});
