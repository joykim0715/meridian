# 운영 메모

실행 파일은 `run-daily.cmd`다. 아래 내용은 선별 규칙 기록이다. 삭제하지 않는다.

---

# SBH News 일일 브리핑

피드: `https://www.sbhnews.com/feed.xml`

순서:

1. `sync_news`로 이 피드만 동기화한다.
2. `fetch_news`로 unread만 가져온다. `includeConsumed: false`, `limit: 500`.
3. 각 unread 기사를 확인한다.
   - 브리핑에 포함: 국제정세, 안보, 경제, 금융, AI/Tech, 한국에 의미 있는 정책 변화
   - 브리핑에서 제외: 생활정보, 행사, 단순 홍보성 단신
   - 제외한 기사도 확인이 끝났으면 consume 대상이다.
   - 기사에 없는 내용은 만들지 않는다. 판단 근거가 없으면 `기사에 없음`이라고 쓴다.
4. 중요한 기사만 아래 형식으로 출력한다.

```
- 제목
- 핵심 내용
- 왜 중요한지
- 한국 관련 영향
- 향후 24~72시간 관찰 포인트
- 원문 URL
```

중요한 기사가 없으면 다음 한 줄만 쓴다.

`오늘 신규 기사 중 별도로 추적할 주요 이슈 없음`

5. `consume_news`로 이번에 확인한 이 피드의 unread를 모두 consume한다. `limit: 500`.
6. `count_news`로 남은 unread를 확인한다. `pastHours: 8760`, `includeConsumed: false`.
7. 마지막 줄은 반드시 다음 형식이다.

`처리: N건 / 남은 unread: M건`

---

# 투자 전략 패널

뉴스 선별 규칙은 위와 같다. 바꾸지 않는다.

창은 가로로 긴 직사각형이다. 왼쪽은 기존 뉴스, 오른쪽은 투자 전략이다. 전략 파일은 `briefings/strategy.md`이고 `latest.md`에 합치지 않는다.

근거는 SBH 글로벌 금융 대시보드만 쓴다. 바구니는 S&P500, QQQ, Vanguard, TIGER, SCHD다. 사용자가 적은 SHUD는 SCHD로 본다. QQQ 시세, TIGER 시세, SCHD 시세는 대시보드에 없으면 만들지 않는다.

내용 순서: ETF 투자 동향, 핵심 경제 지표, 채권 동향. 개인 영향과 다음 행동은 뉴스 요약보다 길게 쓴다.
