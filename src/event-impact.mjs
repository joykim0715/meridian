const CHANNELS = [
  {
    id: "risk",
    words: ["미사일", "공격", "공습", "피격", "사망", "휴전", "전쟁", "안보"],
    driver: "cboe:VIX",
    names: ["S&P500", "Vanguard"],
    pressure: "up",
    path: "무력 충돌은 S&P500 흔들림 예상인 Cboe VIX를 키우는 쪽으로 읽는다.",
  },
  {
    id: "oil",
    words: ["호르무즈", "원유", "유가", "후티", "예멘", "사우디"],
    driver: "fred:DCOILWTICO",
    names: ["QQQ", "SCHD"],
    pressure: "up",
    path: "이 지역 공급 경로는 FRED WTI 원유를 거쳐 금리에 닿고, QQQ와 SCHD로 이어진다.",
  },
  {
    id: "fx",
    words: ["환율", "원화", "원·달러", "달러/원"],
    driver: "fred:DEXKOUS",
    names: ["TIGER"],
    pressure: "up",
    path: "기사에 환율이 있으면 FRED 원·달러로 TIGER의 원화 비용에 닿는다.",
  },
];

export function parseIssues(markdown) {
  const issues = [];
  let current = null;
  for (const raw of String(markdown || "").replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    const heading = trimmed.match(/^###\s+\d+\.\s+(.*)$/);
    if (heading) {
      if (current) issues.push(current);
      current = { title: heading[1], fields: {} };
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith("## ")) {
      issues.push(current);
      current = null;
      continue;
    }
    const item = trimmed.match(/^- ([^:]+):\s*(.*)$/);
    if (item && item[1] !== "관련 기사") current.fields[item[1]] = item[2];
  }
  if (current) issues.push(current);
  return issues;
}

function seriesState(board, driver) {
  const signals = board && board.signals ? board.signals : {};
  const row = (board && board.rows ? board.rows : []).find((item) => item.id === driver);
  if (!signals[driver] || signals[driver] === "missing") return "missing";
  if (row && row.freshnessKind === "stale") return "stale";
  return signals[driver];
}

function effectLine(channel, official) {
  const names = channel.names.join("·");
  if (!official || official === "missing") {
    return `${channel.path} 이 공식 수치가 없어 주수를 바꾸지 않는다.`;
  }
  if (official === "stale") {
    return `${channel.path} 공식 발표가 최근 마감보다 늦어, 그 수치만으로 ${names} 주수를 바꾸지 않는다.`;
  }
  if (official === channel.pressure) {
    return `${channel.path} 공식 20거래일도 같은 방향이다. ${names}는 지표 행동을 유지하고, 오늘은 속도 제한을 넘기지 않는다.`;
  }
  if (official === "flat") {
    return `${channel.path} 공식 20거래일 움직임이 작다. ${names} 주수는 뉴스만으로 바꾸지 않는다.`;
  }
  return `${channel.path} 공식 20거래일은 반대다. ${names} 주수는 뉴스만으로 바꾸지 않고 지표를 따른다.`;
}

export function assessImpact(markdown, board) {
  const byName = {};
  const seen = new Set();
  const issues = parseIssues(markdown).map((issue) => {
    const blob = [issue.title, ...Object.values(issue.fields)].join(" ");
    const effects = [];
    for (const channel of CHANNELS) {
      if (!channel.words.some((word) => blob.includes(word))) continue;
      const state = seriesState(board, channel.driver);
      const line = `${issue.title}: ${effectLine(channel, state)}`;
      effects.push(line);
      for (const name of channel.names) {
        const key = `${name}:${channel.id}:${state}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!byName[name]) byName[name] = [];
        byName[name].push(effectLine(channel, state));
      }
    }
    if (!effects.length) {
      effects.push(`${issue.title}: 다섯 종목의 공식 지표로 이어지는 경로가 기사 안에 없다. 보유 주수는 바꾸지 않는다.`);
    }
    return {
      title: issue.title,
      fact: issue.fields["핵심 내용"] || "",
      watch: issue.fields["향후 24~72시간 관찰 포인트"] || "",
      effects,
    };
  });
  return {
    method: "국제정세 예측은 기사에 적힌 사건과 Cboe·FRED 20거래일 방향이 같은지 비교한 것이다. 목표 가격은 없다.",
    issues,
    byName,
  };
}
