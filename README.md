# SBH News 일일 브리핑

`run-daily.cmd`가 한 번 실행되면 아래 순서로 끝난다.

1. Cursor CLI 로그인 확인. 실패하면 재로그인하지 않고 중단한다.
2. rss-news MCP로 SBH News만 sync한다.
3. unread만 가져온다.
4. unread가 있으면 Cursor CLI에게 분류만 맡긴다. sync와 consume은 이 호출에 넣지 않는다.
5. `briefings/latest.md` 하나만 덮어쓴다. 날짜별 파일은 만들지 않는다.
6. 확인한 unread를 MCP로 consume한다.
7. unread를 다시 조회하고 결과 숫자를 파일에 갱신한다.

뉴스가 0건이어도 브리핑 파일을 만든다. SQLite는 직접 수정하지 않는다.

## 실행

프로젝트 폴더에서 `run-daily.cmd`를 실행한다. 이 갈래는 Cursor CLI로 기사를 분류하고 전략 문장을 쓴다. 다른 PC에서는 그 폴더로 옮긴 뒤, Node, Python, Edge, Cursor CLI 로그인이 있어야 한다. 뉴스 수집 패키지는 그 폴더에서 `npm install` 한 번이면 된다. 매일 등록은 `runtime\register-task.ps1`이다. 이미 등록된 PC에서 이 스크립트를 실행하면 기존 예약을 바꾸지 않고 멈춘다. `runtime\task.xml`은 이 컴퓨터에 등록된 복사본이라 다른 PC에서 그대로 가져오지 않는다.

Cursor 없이 쓰는 갈래는 `run-daily-gemini.cmd`다. 분류와 전략 문장만 Gemini 무료 구간으로 보내고, 뉴스 수집, 지표, 창, 검증은 같다. `.env`에 `GEMINI_API_KEY`를 넣는다. 키는 로그에 남기지 않는다. 매일 등록은 `runtime\register-task-gemini.ps1`이고, 작업 이름은 `SBHNews Daily Briefing Gemini`라 기존 Cursor 예약을 바꾸지 않는다. 이 PC에서는 그 스크립트를 실행하지 않는다.

## 프로그램으로 받기

GitHub 저장소에서 Code, Download ZIP으로 받는다. 압축을 풀면 그 폴더가 프로그램이다. `install-gemini.cmd`를 실행한다. Node, Python, Edge가 있어야 하고, 뉴스 패키지는 그 폴더 안에 설치된다. `.env`의 `GEMINI_API_KEY`를 채운 뒤 `run-daily-gemini.cmd`로 한 번 확인한다. 매일 실행은 `runtime\register-task-gemini.ps1`이다. 설치 스크립트는 예약을 만들지 않는다.

이 PC에서 이미 도는 Cursor 실행은 `run-daily.cmd`다. 그 예약 파일과 키, 로그, 시세 DB는 저장소에 없다.

```bat
run-daily.cmd
```

종료 코드:

- 0 성공
- 1 실행을 시작한 뒤의 실제 실패 또는 부분성공
- 2 인증 실패 (`AUTH_EXPIRED` 또는 `AUTH_CHECK_FAILED`)
- 3 20분 타임아웃
- 4 이미 실행 중이라 건너뜀 (`SKIPPED_ALREADY_RUNNING`)

`run-daily.cmd`를 직접 실행하면 종료 코드 4가 그대로 나온다. `run-daily.cmd --from-scheduler`는 4를 0으로 바꿔 반환한다.

동시 실행은 `runtime/pipeline.lock`으로 막는다. lock이 2시간을 넘기면 이전 실행이 죽은 것으로 보고 지운 뒤 진행한다.

## 결과 위치

- 브리핑: `briefings\latest.md` 하나. 하루의 첫 성공 실행은 아침 브리핑이고 창을 띄운다. 같은 날 이후 확인은 긴급 이슈가 있을 때만 창을 띄우고, 없으면 본문을 유지한 채 조용히 끝낸다. 다음 날 첫 실행은 새 브리핑으로 교체한다.
- 투자 전략: `briefings\strategy.md`. 뉴스 본문에는 넣지 않는다. 창이 뜰 때만 글로벌 금융 대시보드를 다시 읽고 만든다. 왼쪽은 기존 뉴스, 오른쪽은 ETF 투자 동향, 핵심 경제 지표, 채권 동향 순이다. 창 크기는 1280x740이다.
- 로그: `logs\latest.log`. 실패하면 `logs\last-failure.log`에도 남긴다.

`latest.md` 맨 위 세 줄이 마지막 실행 시각, 성공/부분성공/실패, 처리한 unread 수다.

## 금융 데이터 V1

ETF 시세와 거시 지표 수집은 `finance` 패키지가 따로 한다. 뉴스 본문 `briefings\latest.md`와 스케줄, 알림은 바꾸지 않는다. 창이 열리면 맨 위에 S&P500, QQQ, Vanguard, TIGER, SCHD가 먼저 나온다. 각 칸은 그 종목에 가장 직접 연결된 지표의 최근 20거래일 방향과, 그 방향에 따른 나눠 사기 판단만 보여 준다. SCHD는 직접 적은 SHUD다. 긴급 이슈가 없어 창을 띄우지 않는 실행에서도 금융 수치와 화면 파일은 갱신한다. 이미 열려 있는 창은 그때 열린 숫자를 유지한다. 미국 장이 끝나기 전에는 오늘 날짜가 나오지 않고, 환율처럼 공식 발표가 늦은 지표는 그 날짜를 그대로 보여 준다. 키 없이 실제로 받아 저장하는 데이터는 FRED 공개 CSV와 Cboe 공식 CSV다. KRX, FMP, 한국투자증권 시세, 한국은행 ECOS는 키가 있어야 하며 주문 API는 쓰지 않는다.

프로젝트 루트에서 실행한다.

```text
python -m finance check
python -m finance backfill
python -m finance update
python -m finance validate
python -m finance snapshot
python -m unittest discover -s finance/tests -t .
```

`backfill`은 공개 CSV의 제공 범위만큼 받고, 키가 있는 일별 API는 최근 1년이다. 하이일드 스프레드 공개 CSV는 현재 2023-10-16 이후만 내려오므로 그 이전은 FRED API 키가 있어야 한다. 더 긴 국내 이력은 `python -m finance backfill --since 2010-01-04`로 받는다. `update`는 이미 받은 마지막 날짜 근처만 다시 받아 같은 행을 덮어쓰지 않는다. 저장 파일은 `finance\data\market.sqlite`, 스냅샷은 `finance\output\finance_snapshot.json`이다. 키 이름은 `.env.example`에 있다.

작업 스케줄러가 `run-daily.cmd`를 직접 실행하면 콘솔이 닫히면서 Node가 `0xC000013A`로 끝난다. 등록된 작업은 `wscript.exe`로 `runtime\probe.vbs`를 실행하고, 이 스크립트가 `runtime\daily.js`를 끝까지 기다린다. `daily.js`가 `src\run-daily.mjs`를 실행하며 종료 코드 4를 0으로 바꾼다. 매일 07:30에 시작하고 22:30까지 30분마다 반복한다. 그 시각에 컴퓨터가 꺼져 있으면 다음에 켜진 뒤 한 번 이어서 실행한다. 스케줄러 재시도는 0이 아닌 종료 코드에만 걸리므로, 이미 실행 중이라 건너뛴 경우는 재시도하지 않는다. 1, 2, 3은 그대로 전달되어 30분 간격으로 최대 2번 재시도된다.
