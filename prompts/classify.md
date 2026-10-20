SBH News unread 기사를 일일 브리핑용으로 분류한다.

입력 파일 runtime/unread.json 배열의 기사만 사용한다.
파일 밖 지식으로 사건, 숫자, 영향, 전망을 만들지 않는다.
기사에 근거가 없는 항목은 빈 문장 대신 "기사에 없음"이라고 쓴다.

브리핑에 넣을 기사:
- 국제정세, 지정학, 전쟁, 안보, 외교
- 한국의 주요 정책 또는 경제 변화
- 경제, 금융시장, 반도체, AI, Tech
- 한국에 직접 영향이 기사 안에 드러나는 해외 이슈

브리핑에서 빼되, 빠뜨리지 말고 excluded에 넣을 기사:
- 생활정보, 지역 행사, 이벤트 안내, 단순 홍보
- 의미가 작은 기업 단신
- 같은 사건의 의미 없는 반복 또는 재작성

summary와 whatChanged에는 기사에 있는 주체, 장소, 수치를 그대로 남긴다. 수치를 빼고 "긴장이 높아졌다"만 쓰지 않는다.
같은 사건을 다룬 기사는 issues 안 하나의 이슈로 묶는다.
runtime/existing-issues.json 이 있으면, 그 제목과 같은 사건의 새 기사는 새 이슈로 만들지 말고 attachTo에 그 title을 그대로 쓴다. 다른 사건이면 attachTo는 빈 문자열이다. 그 파일이 없으면 attachTo는 생략해도 된다.
모든 entryUid는 issues 또는 excluded 중 정확히 한 곳에만 들어가야 한다.
link는 입력에 있는 값만 그대로 쓴다.

출력은 아래 JSON 하나만 BEGIN_JSON 과 END_JSON 사이에 둔다.
설명, 마크다운 펜스, 도구 호출은 하지 않는다.

BEGIN_JSON
{
  "issues": [
    {
      "title": "이슈 제목",
      "summary": "핵심 내용",
      "whatChanged": "무엇이 달라졌는지",
      "whyItMatters": "왜 중요한지",
      "koreaImpact": "한국 관련 영향",
      "watch": "향후 24~72시간 관찰 포인트",
      "attachTo": "기존 이슈 title 또는 빈 문자열",
      "articles": [
        { "entryUid": "입력 값", "title": "기사 제목", "link": "입력 URL" }
      ]
    }
  ],
  "excluded": [
    { "entryUid": "입력 값", "title": "기사 제목", "reason": "생활정보|행사/이벤트|홍보|기업 단신|반복 기사|중요도 낮음" }
  ]
}
END_JSON
