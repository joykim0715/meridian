import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDisplayDocument } from "./display-page.mjs";
import { loadFinanceMarkdown, readFinanceBoard, refreshFinanceForBriefing } from "./finance-brief.mjs";
import { loadMarketSnapshot } from "./market-snapshot.mjs";
import { openRssClient } from "./mcp-client.mjs";
import {
  assertGeminiReady,
  buildClassifyPrompt,
  buildStrategyPrompt,
  geminiComplete,
  parseModelJson,
  writerKind,
} from "./gemini-writer.mjs";
import { ROOT, cursorAgentPath, edgeExecutable } from "./paths.mjs";

let agentCommand = "";
function cursorAgent() {
  if (!agentCommand) agentCommand = cursorAgentPath();
  return agentCommand;
}
const FEED = "https://www.sbhnews.com/feed.xml";
const LOCK_PATH = path.join(ROOT, "runtime", "pipeline.lock");
const BRIEFING_DIR = path.join(ROOT, "briefings");
const LOG_DIR = path.join(ROOT, "logs");
const STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const FETCH_LIMIT = 500;

const children = new Set();
let lockOwned = false;
let logFile = "";
let finished = false;
let hardTimeout;
let briefingSaved = false;
let lastIssueCount = 0;
let preservedBriefing = false;
let appendSummary = "";
let briefingMode = "morning";
let suppressPopup = false;
let popupMarkdown = "";
let strategyMarkdown = "";
let pipelineStartedAt = 0;

const ETF_ORDER = ["S&P500", "QQQ", "Vanguard", "TIGER", "SCHD"];

function timeoutMs() {
  const raw = process.env.SBHNEWS_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return value;
}

function seoulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  const day = `${pick("year")}-${pick("month")}-${pick("day")}`;
  return {
    day,
    stamp: `${day} ${hour}:${pick("minute")}`,
    fileStamp: `${day}_${hour}${pick("minute")}${pick("second")}`,
  };
}

function ensureDirs() {
  fs.mkdirSync(path.join(ROOT, "runtime"), { recursive: true });
  fs.mkdirSync(BRIEFING_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(line) {
  const row = `[${seoulParts().stamp}] ${line}\n`;
  if (!logFile) return;
  fs.appendFileSync(logFile, row, "utf8");
}

function writeUtf8(file, text) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(file, body, "utf8");
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM found: ${file}`);
  }
  const read = bytes.toString("utf8");
  if (read !== body) throw new Error(`UTF-8 roundtrip failed: ${file}`);
  if (!read.includes("실행 결과")) throw new Error(`Korean text missing: ${file}`);
  return read;
}

function claimLock() {
  ensureDirs();
  let removedStale = false;
  if (fs.existsSync(LOCK_PATH)) {
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (age <= STALE_MS) {
      const error = new Error("LOCK_HELD");
      error.code = "LOCK_HELD";
      throw error;
    }
    fs.unlinkSync(LOCK_PATH);
    removedStale = true;
  }
  try {
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "wx", encoding: "utf8" },
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      const held = new Error("LOCK_HELD");
      held.code = "LOCK_HELD";
      throw held;
    }
    throw error;
  }
  lockOwned = true;
  return removedStale;
}

function releaseLock() {
  if (!lockOwned) return;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const current = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      if (current.pid === process.pid) fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    // The next run treats a leftover lock older than two hours as stale.
  }
  lockOwned = false;
}

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function killChildren() {
  for (const child of children) {
    if (child.pid) {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    }
  }
}

function quoteCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

function cursorCliLaunch(args) {
  const versionsDir = path.join(path.dirname(cursorAgent()), "versions");
  const names = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
    .sort();
  const version = names.at(-1);
  if (!version) throw new Error("Cursor CLI version not found");
  const versionDir = path.join(versionsDir, version);
  return {
    command: path.join(versionDir, "node.exe"),
    args: [path.join(versionDir, "index.js"), ...args],
    env: { ...process.env, CURSOR_INVOKED_AS: "agent.cmd" },
  };
}

function runProcess(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    // Task Scheduler runs run-daily.cmd through cmd.exe. Spawning agent.cmd
    // from there nests another cmd.exe and the process group receives Ctrl+C
    // (exit 0xC000013A). Launch the same CLI binary agent.cmd starts.
    const launch =
      command === cursorAgent()
        ? cursorCliLaunch(args)
        : {
            command: [command, ...args].map(quoteCmd).join(" "),
            args: undefined,
            env: process.env,
            shell: true,
          };
    const spawnOptions = {
      cwd: ROOT,
      windowsHide: true,
      env: launch.env,
    };
    // A second console child in the scheduler's process group raises Ctrl+C
    // (0xC000013A) and kills the briefing. Give the agent its own group.
    if (command === cursorAgent()) spawnOptions.detached = true;
    const child = track(
      launch.shell
        ? spawn(launch.command, { ...spawnOptions, shell: true })
        : spawn(launch.command, launch.args, spawnOptions),
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killChildren();
      reject(new Error(`process timeout: ${path.basename(command)}`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function once(label, fn) {
  try {
    return await fn();
  } catch (error) {
    log(`${label} failed, retry once: ${error.message}`);
    return fn();
  }
}

async function checkAuth() {
  if (writerKind() === "gemini") {
    await assertGeminiReady();
    log("auth ok writer=gemini");
    return;
  }
  const result = await once("auth", () => runProcess(cursorAgent(), ["status", "--format", "json"], 60000));
  if (result.code !== 0) {
    const error = new Error("AUTH_CHECK_FAILED");
    error.code = "AUTH";
    throw error;
  }
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  if (start === -1 || end === -1) {
    const error = new Error("AUTH_CHECK_FAILED");
    error.code = "AUTH";
    throw error;
  }
  const status = JSON.parse(result.stdout.slice(start, end + 1));
  if (status.isAuthenticated !== true) {
    const error = new Error("AUTH_EXPIRED");
    error.code = "AUTH";
    throw error;
  }
  log("auth ok");
}

async function withRss(fn) {
  const client = openRssClient();
  track(client.child);
  try {
    await client.start();
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function syncFeed() {
  return withRss(async (client) => {
    const result = await client.callTool("sync_news", { feedUrls: [FEED] }, 90000);
    if ((result.summary?.errorFeeds ?? 0) > 0) {
      throw new Error(`sync errorFeeds=${result.summary.errorFeeds}`);
    }
    log(
      `sync ok fetched=${result.summary?.fetchedTotal ?? 0} inserted=${result.summary?.insertedTotal ?? 0}`,
    );
    return result;
  });
}

async function fetchUnread() {
  return withRss(async (client) => {
    const result = await client.callTool("fetch_news", {
      feedUrls: [FEED],
      limit: FETCH_LIMIT,
      includeConsumed: false,
    });
    const items = Array.isArray(result.items) ? result.items : [];
    log(`fetch unread=${items.length}`);
    return items;
  });
}

async function consumeUnread(expected) {
  return withRss(async (client) => {
    const result = await client.callTool("consume_news", {
      feedUrls: [FEED],
      limit: Math.min(FETCH_LIMIT, Math.max(expected, 1)),
      includeConsumed: false,
    });
    log(`consume count=${result.consumedCount ?? 0}`);
    return result.consumedCount ?? 0;
  });
}

async function countUnread() {
  return withRss(async (client) => {
    const result = await client.callTool("count_news", {
      feedUrls: [FEED],
      pastHours: 8760,
      includeConsumed: false,
    });
    log(`count_news unread=${result.totalCount ?? 0}`);
    return result.totalCount ?? 0;
  });
}

function textOrGap(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || "기사에 없음";
}

export function validateClassification(items, parsed) {
  const expected = new Set(items.map((item) => item.entryUid));
  const seen = new Set();
  const issues = Array.isArray(parsed.issues) ? parsed.issues : null;
  const excluded = Array.isArray(parsed.excluded) ? parsed.excluded : null;
  if (!issues || !excluded) throw new Error("classification missing issues or excluded");
  const knownLinks = new Set(items.map((item) => item.link));

  for (const issue of issues) {
    if (!Array.isArray(issue.articles) || issue.articles.length === 0) {
      throw new Error("issue has no articles");
    }
    for (const article of issue.articles) {
      if (!expected.has(article.entryUid)) throw new Error(`unknown entryUid ${article.entryUid}`);
      if (seen.has(article.entryUid)) throw new Error(`duplicate entryUid ${article.entryUid}`);
      if (!knownLinks.has(article.link)) throw new Error(`unknown link ${article.link}`);
      seen.add(article.entryUid);
    }
  }
  for (const article of excluded) {
    if (!expected.has(article.entryUid)) throw new Error(`unknown excluded entryUid ${article.entryUid}`);
    if (seen.has(article.entryUid)) throw new Error(`duplicate entryUid ${article.entryUid}`);
    seen.add(article.entryUid);
  }
  for (const entryUid of expected) {
    if (!seen.has(entryUid)) throw new Error(`missing entryUid ${entryUid}`);
  }
  return { issues, excluded };
}

function parseAgentJson(stdout) {
  const start = stdout.lastIndexOf("BEGIN_JSON");
  const end = stdout.lastIndexOf("END_JSON");
  if (start === -1 || end === -1 || end <= start) throw new Error("agent JSON markers missing");
  const block = stdout.slice(start + "BEGIN_JSON".length, end).trim();
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("agent JSON object missing");
  return JSON.parse(block.slice(jsonStart, jsonEnd + 1));
}

async function classify(items, previousError = "", existingIssues = [], mode = "morning") {
  const payload = items.map((item) => ({
    entryUid: item.entryUid,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    contentSnippet: item.contentSnippet,
  }));
  fs.writeFileSync(path.join(ROOT, "runtime", "unread.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const existingPath = path.join(ROOT, "runtime", "existing-issues.json");
  if (existingIssues.length > 0) {
    fs.writeFileSync(existingPath, `${JSON.stringify(existingIssues, null, 2)}\n`, "utf8");
  } else if (fs.existsSync(existingPath)) {
    fs.unlinkSync(existingPath);
  }
  const reminder = previousError
    ? ` The previous output was invalid: ${previousError.replaceAll(/[%&|<>^"\r\n]/g, " ")}. Return corrected JSON only.`
    : "";
  const mergeNote = existingIssues.length
    ? " Also read runtime/existing-issues.json. If a new article continues one of those issues, set attachTo to that exact title. Otherwise set attachTo to an empty string."
    : "";
  const spec = mode === "urgent" ? "prompts/classify-urgent.md" : "prompts/classify.md";
  if (writerKind() === "gemini") {
    const prompt = buildClassifyPrompt({
      spec: fs.readFileSync(path.join(ROOT, spec), "utf8"),
      unread: fs.readFileSync(path.join(ROOT, "runtime", "unread.json"), "utf8"),
      existing: existingIssues.length ? fs.readFileSync(existingPath, "utf8") : "",
      reminder: `${mergeNote}${reminder}`,
    });
    log("classify via gemini");
    const text = await geminiComplete(prompt, 8 * 60 * 1000);
    return validateClassification(items, parseModelJson(text));
  }
  const prompt =
    `Read ${spec} and runtime/unread.json. Classify only those articles. ` +
    "Do not call MCP, do not sync, do not consume, and do not edit files. " +
    `Print only BEGIN_JSON, one JSON object, and END_JSON.${mergeNote}${reminder}`;
  const result = await runProcess(
    cursorAgent(),
    ["--trust", "-p", "--output-format", "text", "--mode", "ask", "--workspace", ROOT, prompt],
    8 * 60 * 1000,
  );
  if (result.code !== 0) throw new Error(`agent exit ${result.code}`);
  const parsed = parseAgentJson(result.stdout);
  return validateClassification(items, parsed);
}

async function classifyWithRetry(items, existingIssues = [], mode = "morning") {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const classified = await classify(items, lastError, existingIssues, mode);
      log(`classify ok mode=${mode} issues=${classified.issues.length} excluded=${classified.excluded.length}`);
      return classified;
    } catch (error) {
      lastError = error.message;
      if (attempt === 2) throw error;
      log(`classify failed, retry once: ${error.message}`);
    }
  }
  throw new Error("classify failed");
}

function reasonCounts(excluded) {
  const counts = new Map();
  for (const article of excluded) {
    const reason = textOrGap(article.reason);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason} ${count}건`).join(", ");
}

export function renderBriefing({ when, status, items, classified, consumed, remaining }) {
  const issues = classified?.issues ?? [];
  const excluded = classified?.excluded ?? [];
  const includedCount = issues.reduce((sum, issue) => sum + issue.articles.length, 0);
  const lines = [
    "# Meridian",
    "",
    `- 마지막 실행 시각: ${when.stamp}`,
    `- 마지막 실행 결과: ${status}`,
    `- 이번 실행에서 처리한 unread 수: ${items.length}`,
    "",
    `날짜: ${when.day}`,
    `실행 시각: ${when.stamp}`,
    `실행 결과: ${status}`,
    "",
    "## 오늘의 핵심 동향",
    "",
  ];

  if (issues.length === 0) {
    lines.push("오늘 신규 기사 중 별도로 추적할 주요 이슈 없음", "");
  } else {
    issues.forEach((issue, index) => {
      lines.push(
        `### ${index + 1}. ${textOrGap(issue.title)}`,
        `- 핵심 내용: ${textOrGap(issue.summary)}`,
        `- 무엇이 달라졌는지: ${textOrGap(issue.whatChanged)}`,
        `- 왜 중요한지: ${textOrGap(issue.whyItMatters)}`,
        `- 한국 관련 영향: ${textOrGap(issue.koreaImpact)}`,
        `- 향후 24~72시간 관찰 포인트: ${textOrGap(issue.watch)}`,
        "- 관련 기사:",
      );
      for (const article of issue.articles) {
        lines.push(`  - ${textOrGap(article.title)}`, `  - ${article.link}`);
      }
      lines.push("");
    });
  }

  lines.push("## 제외된 기사", "");
  if (excluded.length === 0) lines.push("제외된 기사 없음.", "");
  else lines.push(`제외 ${excluded.length}건. 사유: ${reasonCounts(excluded)}.`, "");

  lines.push(
    "## 처리 결과",
    "",
    `- 신규 unread: ${items.length}`,
    `- 브리핑 포함: ${includedCount}`,
    `- 제외: ${excluded.length}`,
    `- consume: ${consumed}`,
    `- 남은 unread: ${remaining}`,
    "",
  );
  return lines.join("\n");
}

function requireStrategyText(value, label, minimum) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length < minimum) throw new Error(`${label} too short`);
  if (/https?:\/\//.test(text)) throw new Error(`${label} has a url`);
  return text;
}

export function validateStrategy(parsed) {
  if (!parsed || typeof parsed !== "object") throw new Error("strategy is not an object");
  requireStrategyText(parsed.stance, "stance", 12);
  if (!Array.isArray(parsed.etf)) throw new Error("strategy missing etf");
  const names = parsed.etf.map((item) => String(item?.name ?? "").trim());
  if (names.length !== ETF_ORDER.length) throw new Error("strategy etf count");
  for (const name of ETF_ORDER) {
    if (!names.includes(name)) throw new Error(`strategy missing ${name}`);
  }
  for (const item of parsed.etf) {
    const name = String(item.name).trim();
    for (const key of ["move", "volatility", "investorImpact", "action"]) {
      const minimum = key === "investorImpact" || key === "action" ? 50 : 30;
      requireStrategyText(item[key], `${name} ${key}`, minimum);
    }
  }
  for (const block of ["indicators", "bonds"]) {
    const value = parsed[block];
    if (!value || typeof value !== "object") throw new Error(`strategy missing ${block}`);
    for (const key of ["summary", "investorImpact", "action"]) {
      requireStrategyText(value[key], `${block} ${key}`, 40);
    }
  }
  if (!Array.isArray(parsed.nextActions) || parsed.nextActions.length < 3 || parsed.nextActions.length > 5) {
    throw new Error("nextActions must be 3 to 5");
  }
  parsed.nextActions.forEach((action, index) => requireStrategyText(action, `nextActions ${index}`, 12));
  return parsed;
}

export function renderStrategy(strategy, fetchedAt) {
  const byName = new Map(strategy.etf.map((item) => [String(item.name).trim(), item]));
  const lines = [
    "# 투자 전략",
    "",
    `- 대시보드 시각: ${textOrGap(fetchedAt)}`,
    `- 오늘의 태도: ${textOrGap(strategy.stance)}`,
    "",
    "## ETF 투자 동향",
    "",
  ];
  ETF_ORDER.forEach((name, index) => {
    const item = byName.get(name);
    lines.push(
      `### ${index + 1}. ${name}`,
      `- 움직임: ${textOrGap(item?.move)}`,
      `- 변동성: ${textOrGap(item?.volatility)}`,
      `- 개인 영향: ${textOrGap(item?.investorImpact)}`,
      `- 다음 행동: ${textOrGap(item?.action)}`,
      "",
    );
  });
  lines.push(
    "## 핵심 경제 지표",
    "",
    "### 지표가 바구니에 주는 의미",
    `- 요약: ${textOrGap(strategy.indicators?.summary)}`,
    `- 개인 영향: ${textOrGap(strategy.indicators?.investorImpact)}`,
    `- 다음 행동: ${textOrGap(strategy.indicators?.action)}`,
    "",
    "## 채권 동향",
    "",
    "### 금리가 바구니에 주는 의미",
    `- 요약: ${textOrGap(strategy.bonds?.summary)}`,
    `- 개인 영향: ${textOrGap(strategy.bonds?.investorImpact)}`,
    `- 다음 행동: ${textOrGap(strategy.bonds?.action)}`,
    "",
    "## 다음 투자 행동",
    "",
  );
  for (const action of strategy.nextActions ?? []) lines.push(`- ${String(action).trim()}`);
  lines.push("", "이 내용은 글로벌 금융 대시보드 수치를 읽은 브리핑이며, 매매 지시가 아닙니다.", "");
  return lines.join("\n");
}

function quoteFact(quote) {
  if (!quote || quote.price == null) return "대시보드에 없음";
  const name = quote.label || quote.symbol || quote.id || "수치";
  const move = quote.changePctLabel || quote.dayChangePctLabel || "";
  return move ? `${name} ${quote.price} (직전 대비 ${move})` : `${name} ${quote.price}`;
}

export function renderStrategyFallback(snapshot) {
  const lines = [
    "# 투자 전략",
    "",
    `- 대시보드 시각: ${snapshot?.fetchedAt || "없음"}`,
    "- 상태: 전략 문장을 만들지 못했습니다",
    "",
  ];
  if (!snapshot) {
    lines.push("글로벌 금융 대시보드를 읽지 못했습니다.", "");
    return lines.join("\n");
  }
  const byName = new Map((snapshot.basket || []).map((item) => [item.name, item]));
  lines.push("## 대시보드에 있는 수치", "");
  for (const name of ETF_ORDER) {
    const item = byName.get(name);
    const fact = item?.quote
      ? quoteFact(item.quote)
      : item?.quotes
        ? `${quoteFact(item.quotes.sp500)} / ${quoteFact(item.quotes.nasdaqComposite)} / ${quoteFact(item.quotes.usdKrw)}`
        : "대시보드에 가격 없음";
    lines.push(`### ${name}`, `- 움직임: ${fact}`, `- 한계: ${textOrGap(item?.limit)}`, "");
  }
  lines.push(
    "### 변동성과 금리",
    `- 움직임: ${quoteFact(snapshot.volatility)}`,
    `- 움직임: ${quoteFact(snapshot.dollarIndex)}`,
  );
  for (const yieldRow of snapshot.yields || []) {
    lines.push(`- 움직임: ${yieldRow.label} ${yieldRow.yieldPct}% (오늘 ${yieldRow.dayChangePctPointLabel}%포인트)`);
  }
  lines.push("", "이 내용은 글로벌 금융 대시보드 수치를 읽은 브리핑이며, 매매 지시가 아닙니다.", "");
  return lines.join("\n");
}

async function writeStrategy(text) {
  ensureDirs();
  const file = path.join(BRIEFING_DIR, "strategy.md");
  const body = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(file, body, "utf8");
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM found: ${file}`);
  }
  const read = bytes.toString("utf8");
  if (read !== body) throw new Error(`UTF-8 roundtrip failed: ${file}`);
  if (!read.includes("투자 전략")) throw new Error(`Korean text missing: ${file}`);
  strategyMarkdown = read;
  log(`strategy saved ${file}`);
}

function strategyBudget() {
  if (!pipelineStartedAt) return 5 * 60 * 1000;
  return timeoutMs() - (Date.now() - pipelineStartedAt) - 20000;
}

async function draftStrategy(previousError = "", attemptTimeout = 5 * 60 * 1000) {
  const reminder = previousError
    ? ` The previous output was invalid: ${previousError.replaceAll(/[%&|<>^"\r\n]/g, " ")}. Return corrected JSON only.`
    : "";
  if (writerKind() === "gemini") {
    const prompt = buildStrategyPrompt({
      spec: fs.readFileSync(path.join(ROOT, "prompts", "strategy.md"), "utf8"),
      snapshot: fs.readFileSync(path.join(ROOT, "runtime", "market-snapshot.json"), "utf8"),
      reminder,
    });
    log("strategy via gemini");
    const text = await geminiComplete(prompt, attemptTimeout);
    return validateStrategy(parseModelJson(text));
  }
  const prompt =
    "Read prompts/strategy.md and runtime/market-snapshot.json. " +
    "Write the strategy from that file only. " +
    "Do not call MCP, do not sync, do not consume, and do not edit files. " +
    `Print only BEGIN_JSON, one JSON object, and END_JSON.${reminder}`;
  const result = await runProcess(
    cursorAgent(),
    ["--trust", "-p", "--output-format", "text", "--mode", "ask", "--workspace", ROOT, prompt],
    attemptTimeout,
  );
  if (result.code !== 0) throw new Error(`strategy agent exit ${result.code}`);
  return validateStrategy(parseAgentJson(result.stdout));
}

export async function attachStrategy() {
  let snapshot = null;
  try {
    snapshot = await loadMarketSnapshot();
    const snapshotPath = path.join(ROOT, "runtime", "market-snapshot.json");
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    log("market snapshot saved");
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const budget = strategyBudget();
      if (budget < 60000) {
        log("strategy skipped, little time left");
        break;
      }
      try {
        log("strategy agent start");
        const strategy = await draftStrategy(lastError, Math.min(5 * 60 * 1000, budget));
        await writeStrategy(renderStrategy(strategy, snapshot.fetchedAt));
        log("strategy ok");
        return;
      } catch (error) {
        lastError = error.message;
        log(`strategy failed, ${attempt === 1 ? "retry once" : "use dashboard figures"}: ${error.message}`);
      }
    }
    await writeStrategy(renderStrategyFallback(snapshot));
  } catch (error) {
    log(`strategy failed: ${error.message}`);
    try {
      await writeStrategy(renderStrategyFallback(snapshot));
    } catch (writeError) {
      strategyMarkdown = renderStrategyFallback(snapshot);
      log(`strategy file not saved: ${writeError.message}`);
    }
  }
}

export function renderUrgentBriefing({ when, classified }) {
  const issues = classified?.issues ?? [];
  const lines = [
    "# Meridian 긴급 이슈",
    "",
    `확인 시각: ${when.stamp}`,
    "",
    "## 새로 확인한 긴급 이슈",
    "",
  ];
  issues.forEach((issue, index) => {
    lines.push(
      `### ${index + 1}. ${textOrGap(issue.title)}`,
      `- 핵심 내용: ${textOrGap(issue.summary)}`,
      `- 무엇이 달라졌는지: ${textOrGap(issue.whatChanged)}`,
      `- 왜 중요한지: ${textOrGap(issue.whyItMatters)}`,
      `- 한국 관련 영향: ${textOrGap(issue.koreaImpact)}`,
      `- 향후 24~72시간 관찰 포인트: ${textOrGap(issue.watch)}`,
      "- 관련 기사:",
    );
    for (const article of issue.articles ?? []) {
      lines.push(`  - ${textOrGap(article.title)}`, `  - ${article.link}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function latestFile() {
  return path.join(BRIEFING_DIR, "latest.md");
}

function morningDayFile() {
  return path.join(ROOT, "runtime", "morning-day.txt");
}

function readMorningDay() {
  try {
    return fs.readFileSync(morningDayFile(), "utf8").trim();
  } catch {
    return "";
  }
}

function writeMorningDay(day) {
  fs.writeFileSync(morningDayFile(), `${day}\n`, "utf8");
}

export function isTodayCompletedBriefing(text, day) {
  if (!text) return false;
  const dateLine = text.match(/^날짜: (\d{4}-\d{2}-\d{2})$/m);
  if (!dateLine || dateLine[1] !== day) return false;
  if (text.includes("남은 unread: 확인 중")) return false;
  if (text.includes("실행 결과: 실패")) return false;
  return text.includes("## 오늘의 핵심 동향");
}

export function selectRunMode(day, morningDay, briefingText) {
  if (morningDay === day && isTodayCompletedBriefing(briefingText, day)) return "urgent";
  return "morning";
}

export function isTodayIssueBriefing(text, day) {
  if (!text) return false;
  const dateLine = text.match(/^날짜: (\d{4}-\d{2}-\d{2})$/m);
  if (!dateLine || dateLine[1] !== day) return false;
  if (!/^### /m.test(text)) return false;
  if (text.includes("남은 unread: 확인 중")) return false;
  return true;
}

export function preserveTodayBriefing(existing, when, unreadCount = 0) {
  let text = existing
    .replace(/^- 마지막 실행 시각: .+$/m, `- 마지막 실행 시각: ${when.stamp}`)
    .replace(/^- 마지막 실행 결과: .+$/m, "- 마지막 실행 결과: 성공")
    .replace(/^- 이번 실행에서 처리한 unread 수: .+$/m, `- 이번 실행에서 처리한 unread 수: ${unreadCount}`);
  if (/^- 추가 신규 기사: .+$/m.test(text)) {
    text = text.replace(/^- 추가 신규 기사: .+$/m, "- 추가 신규 기사: 0");
  } else {
    text = text.replace(
      new RegExp(`^- 이번 실행에서 처리한 unread 수: ${unreadCount}$`, "m"),
      `- 이번 실행에서 처리한 unread 수: ${unreadCount}\n- 추가 신규 기사: 0`,
    );
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeTitle(title) {
  return String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseBriefingIssues(text) {
  const issues = [];
  const blocks = String(text ?? "").split(/^### \d+\. /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = lines[0]?.trim() ?? "";
    const field = (label) => {
      const line = lines.find((item) => item.startsWith(`- ${label}:`));
      return line ? line.slice(`- ${label}:`.length).trim() : "기사에 없음";
    };
    const articles = [];
    let inArticles = false;
    for (const line of lines) {
      if (line.startsWith("- 관련 기사:")) {
        inArticles = true;
        continue;
      }
      if (!inArticles || !line.startsWith("  - ")) continue;
      const value = line.slice(4).trim();
      if (/^https?:\/\//.test(value)) {
        if (articles.length === 0 || articles[articles.length - 1].link) articles.push({ title: "", link: value });
        else articles[articles.length - 1].link = value;
      } else if (articles.length === 0 || articles[articles.length - 1].link) {
        articles.push({ title: value, link: "" });
      } else {
        articles[articles.length - 1].title = value;
      }
    }
    if (title) {
      issues.push({
        title,
        summary: field("핵심 내용"),
        whatChanged: field("무엇이 달라졌는지"),
        whyItMatters: field("왜 중요한지"),
        koreaImpact: field("한국 관련 영향"),
        watch: field("향후 24~72시간 관찰 포인트"),
        articles: articles.filter((article) => article.link),
      });
    }
  }
  return issues;
}

export function mergeIssueLists(existingIssues, newIssues) {
  const merged = existingIssues.map((issue) => ({
    ...issue,
    articles: issue.articles.map((article) => ({ ...article })),
  }));
  let addedIssues = 0;
  let addedArticles = 0;
  let mergedArticles = 0;
  for (const issue of newIssues) {
    const attachTo = String(issue.attachTo ?? "").trim();
    const attached = attachTo
      ? merged.find((item) => normalizeTitle(item.title) === normalizeTitle(attachTo))
      : null;
    const sameTitle = merged.find((item) => normalizeTitle(item.title) === normalizeTitle(issue.title));
    const target = attached || sameTitle || null;
    if (target) {
      const links = new Set(target.articles.map((article) => article.link));
      for (const article of issue.articles ?? []) {
        if (!article.link || links.has(article.link)) continue;
        target.articles.push({ title: textOrGap(article.title), link: article.link });
        links.add(article.link);
        mergedArticles += 1;
      }
      continue;
    }
    merged.push({
      title: textOrGap(issue.title),
      summary: textOrGap(issue.summary),
      whatChanged: textOrGap(issue.whatChanged),
      whyItMatters: textOrGap(issue.whyItMatters),
      koreaImpact: textOrGap(issue.koreaImpact),
      watch: textOrGap(issue.watch),
      articles: (issue.articles ?? []).map((article) => ({ title: textOrGap(article.title), link: article.link })),
    });
    addedIssues += 1;
    addedArticles += (issue.articles ?? []).filter((article) => article.link).length;
  }
  return { issues: merged, addedIssues, addedArticles, mergedArticles };
}

function formatIssues(issues) {
  const lines = [];
  issues.forEach((issue, index) => {
    lines.push(
      `### ${index + 1}. ${textOrGap(issue.title)}`,
      `- 핵심 내용: ${textOrGap(issue.summary)}`,
      `- 무엇이 달라졌는지: ${textOrGap(issue.whatChanged)}`,
      `- 왜 중요한지: ${textOrGap(issue.whyItMatters)}`,
      `- 한국 관련 영향: ${textOrGap(issue.koreaImpact)}`,
      `- 향후 24~72시간 관찰 포인트: ${textOrGap(issue.watch)}`,
      "- 관련 기사:",
    );
    for (const article of issue.articles) {
      lines.push(`  - ${textOrGap(article.title)}`, `  - ${article.link}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function sectionBetween(text, start, end) {
  const startAt = text.indexOf(start);
  if (startAt === -1) return "";
  const from = startAt + start.length;
  const endAt = text.indexOf(end, from);
  return (endAt === -1 ? text.slice(from) : text.slice(from, endAt)).trim();
}

export function appendTodayBriefing(existing, when, { items, classified, consumed, remaining }) {
  const existingIssues = parseBriefingIssues(existing);
  const { issues, addedIssues, addedArticles, mergedArticles } = mergeIssueLists(existingIssues, classified?.issues ?? []);
  const status = remaining === 0 ? "성공" : "부분성공";
  let excludedBlock = sectionBetween(existing, "## 제외된 기사", "## 처리 결과");
  const excluded = classified?.excluded ?? [];
  if (excluded.length > 0) {
    const line = `이번 확인 제외 ${excluded.length}건. 사유: ${reasonCounts(excluded)}.`;
    excludedBlock = !excludedBlock || excludedBlock === "제외된 기사 없음." ? line : `${excludedBlock}\n\n${line}`;
  }
  if (!excludedBlock) excludedBlock = "제외된 기사 없음.";
  let header = existing.split("## 오늘의 핵심 동향")[0];
  header = header
    .replace(/^- 마지막 실행 시각: .+$/m, `- 마지막 실행 시각: ${when.stamp}`)
    .replace(/^- 마지막 실행 결과: .+$/m, `- 마지막 실행 결과: ${status}`)
    .replace(/^- 이번 실행에서 처리한 unread 수: .+$/m, `- 이번 실행에서 처리한 unread 수: ${items.length}`);
  if (/^- 추가 신규 기사: .+$/m.test(header)) {
    header = header.replace(/^- 추가 신규 기사: .+$/m, `- 추가 신규 기사: ${addedArticles + mergedArticles}`);
  } else {
    header = header.replace(
      /^- 이번 실행에서 처리한 unread 수: .+$/m,
      `- 이번 실행에서 처리한 unread 수: ${items.length}\n- 추가 신규 기사: ${addedArticles + mergedArticles}`,
    );
  }
  const includedCount = issues.reduce((sum, issue) => sum + issue.articles.length, 0);
  const text = `${header.replace(/\s*$/, "\n\n")}## 오늘의 핵심 동향\n\n${formatIssues(issues)}## 제외된 기사\n\n${excludedBlock}\n\n## 처리 결과\n\n- 신규 unread: ${items.length}\n- 브리핑 포함: ${includedCount}\n- 제외: ${excluded.length}\n- consume: ${consumed}\n- 남은 unread: ${remaining}\n`;
  return { text, addedIssues, addedArticles, mergedArticles, issueCount: issues.length };
}

function writeBriefing(text) {
  ensureDirs();
  const latest = latestFile();
  writeUtf8(latest, text);
  for (const name of fs.readdirSync(BRIEFING_DIR)) {
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) fs.unlinkSync(path.join(BRIEFING_DIR, name));
  }
  briefingSaved = true;
  log(`briefing saved ${latest}`);
}

function writeFailure(when, reason) {
  const existing = fs.existsSync(latestFile()) ? fs.readFileSync(latestFile(), "utf8") : "";
  if (isTodayIssueBriefing(existing, when.day)) {
    log("failure left today's briefing in place");
    return;
  }
  const text = renderBriefing({
    when,
    status: "실패",
    items: [],
    classified: { issues: [], excluded: [] },
    consumed: 0,
    remaining: "확인 전",
  }).replace(
    "오늘 신규 기사 중 별도로 추적할 주요 이슈 없음",
    `이번 실행은 브리핑을 만들지 못했습니다. 사유: ${reason}`,
  );
  try {
    writeBriefing(text);
  } catch (error) {
    log(`failure briefing not saved: ${error.message}`);
  }
}

async function checkClassifier() {
  const items = [
    {
      entryUid: "smoke-1",
      title: "테스트 기사: 분류기 연결 확인",
      link: "https://example.com/sbhnews-classifier-smoke",
      publishedAt: "2026-09-23",
      contentSnippet: "이 문장은 분류기 연결 테스트용이다. 실제 뉴스가 아니다.",
    },
  ];
  const classified = await classifyWithRetry(items);
  log(`classifier smoke ok accounted=${classified.issues.length + classified.excluded.length}`);
}

async function newsPipeline() {
  await once("sync", syncFeed);
  const items = await once("fetch", fetchUnread);
  const when = seoulParts();
  const existingText = fs.existsSync(latestFile()) ? fs.readFileSync(latestFile(), "utf8") : "";
  const keepToday = isTodayIssueBriefing(existingText, when.day);
  const mode = selectRunMode(when.day, readMorningDay(), existingText);
  briefingMode = mode;
  log(`mode=${mode}`);
  const existingIssues = keepToday
    ? parseBriefingIssues(existingText).map((issue) => ({ title: issue.title, summary: issue.summary }))
    : [];
  let classified = { issues: [], excluded: [] };
  if (items.length > 0) classified = await classifyWithRetry(items, existingIssues, mode);

  const protectToday = keepToday || (mode === "urgent" && isTodayCompletedBriefing(existingText, when.day));
  let consumed = 0;
  if (items.length > 0) {
    if (!protectToday) {
      writeBriefing(
        renderBriefing({
          when,
          status: "성공",
          items,
          classified,
          consumed: items.length,
          remaining: "확인 중",
        }),
      );
    }
    try {
      consumed = await once("consume", () => consumeUnread(items.length));
    } catch (error) {
      if (protectToday) log("consume failed, today's briefing kept");
      else {
        writeBriefing(
          renderBriefing({
            when,
            status: "실패",
            items,
            classified,
            consumed: 0,
            remaining: "확인 전",
          }),
        );
      }
      throw error;
    }
  }

  const remainingFetch = await once("refetch", fetchUnread);
  await countUnread();
  const remaining = remainingFetch.length;
  const finishMorning = (code) => {
    if (code === 0) writeMorningDay(when.day);
    return code;
  };

  if (mode === "urgent") {
    if (remaining !== 0 && classified.issues.length === 0) {
      log("result=부분성공 urgent quiet");
      return 1;
    }
    if (classified.issues.length === 0) {
      writeBriefing(preserveTodayBriefing(existingText, when, items.length));
      suppressPopup = true;
      log(`result=성공 urgent quiet unread=${items.length}`);
      return 0;
    }
    const urgentStatus = remaining === 0 ? "성공" : "부분성공";
    const merged = appendTodayBriefing(existingText, when, { items, classified, consumed, remaining });
    writeBriefing(merged.text);
    popupMarkdown = renderUrgentBriefing({ when, classified });
    lastIssueCount = classified.issues.length;
    log(`result=${urgentStatus} urgent issues=${classified.issues.length} addedIssues=${merged.addedIssues} mergedArticles=${merged.mergedArticles}`);
    return remaining === 0 ? 0 : 1;
  }

  if (items.length === 0) {
    const existing = fs.existsSync(latestFile()) ? fs.readFileSync(latestFile(), "utf8") : "";
    if (isTodayIssueBriefing(existing, when.day)) {
      if (remaining !== 0) {
        log("result=부분성공 kept today's briefing");
        return 1;
      }
      preservedBriefing = true;
      writeBriefing(preserveTodayBriefing(existing, when));
      log("result=성공 preserved today briefing");
      return finishMorning(0);
    }
    if (remaining === 0) {
      lastIssueCount = 0;
      writeBriefing(
        renderBriefing({
          when,
          status: "성공",
          items,
          classified,
          consumed: 0,
          remaining: 0,
        }),
      );
      log("result=성공 empty day briefing");
      return finishMorning(0);
    }
  }
  if (items.length > 0 && keepToday) {
    const status = remaining === 0 ? "성공" : "부분성공";
    const merged = appendTodayBriefing(existingText, when, { items, classified, consumed, remaining });
    lastIssueCount = merged.issueCount;
    const parts = [];
    if (merged.addedIssues > 0) parts.push(`이슈 ${merged.addedIssues}건 추가`);
    if (merged.mergedArticles > 0) parts.push(`기존 이슈에 기사 ${merged.mergedArticles}건 합침`);
    appendSummary = parts.length === 0
      ? "추가 신규 기사 0건. 오늘 브리핑은 유지됩니다."
      : `오늘 브리핑에 ${parts.join(", ")}. / 현재 주요 이슈 ${merged.issueCount}건`;
    writeBriefing(merged.text);
    log(`result=${status} appended today briefing addedIssues=${merged.addedIssues} mergedArticles=${merged.mergedArticles}`);
    return finishMorning(remaining === 0 ? 0 : 1);
  }
  const status = remaining === 0 ? "성공" : "부분성공";
  if (remaining === 0) lastIssueCount = classified.issues.length;
  writeBriefing(
    renderBriefing({
      when,
      status,
      items,
      classified,
      consumed,
      remaining,
    }),
  );
  if (items.length === FETCH_LIMIT) log("fetch cap reached");
  log(`result=${status} exitPending=${remaining === 0 ? 0 : 1}`);
  return finishMorning(remaining === 0 ? 0 : 1);
}

async function attachFinance() {
  try {
    await refreshFinanceForBriefing();
    log("finance brief ready");
  } catch (error) {
    log(`finance brief failed: ${String(error.message).replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

async function pipeline() {
  pipelineStartedAt = Date.now();
  const code = await newsPipeline();
  if (code === 0) {
    await attachFinance();
    if (!suppressPopup) await attachStrategy();
    else {
      try {
        writeBriefingPage();
        log("finance page refreshed without popup");
      } catch (error) {
        log(`finance page failed: ${String(error.message).replace(/\s+/g, " ").slice(0, 300)}`);
      }
    }
  }
  return code;
}

function runHiddenPowershell(args, env = {}) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", ...args], {
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(detail || `powershell exit ${result.status}`);
  }
}

function briefingParts() {
  const markdown = popupMarkdown || fs.readFileSync(path.join(BRIEFING_DIR, "latest.md"), "utf8");
  const strategyPath = path.join(BRIEFING_DIR, "strategy.md");
  const strategy = strategyMarkdown
    || (fs.existsSync(strategyPath) ? fs.readFileSync(strategyPath, "utf8") : "# 투자 전략\n\n이번 실행에서는 전략 제언이 없습니다.\n");
  let finance = "# 수집 금융 데이터\n\n금융 데이터를 읽지 못했다. 뉴스 브리핑은 그대로 표시한다.\n";
  try {
    finance = loadFinanceMarkdown();
  } catch (error) {
    log(`finance render failed: ${String(error.message).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return { markdown, strategy, finance, board: readFinanceBoard() };
}

export function writeBriefingPage() {
  const parts = briefingParts();
  const displayPath = path.join(ROOT, "runtime", "display.html");
  fs.writeFileSync(displayPath, renderDisplayDocument(parts.markdown, parts.strategy, parts.finance, parts.board), "utf8");
  return displayPath;
}

export function showBriefingWindow() {
  const displayPath = writeBriefingPage();
  const edge = edgeExecutable();
  const profile = path.join(process.env.LOCALAPPDATA || ROOT, "Meridian", "edge-profile");
  fs.mkdirSync(profile, { recursive: true });
  const fileUrl = "file:///" + displayPath.replaceAll("\\", "/") + "?t=" + Date.now();
  const args = `--user-data-dir=${profile} --app=${fileUrl} --window-size=1280,740 --window-position=36,24 --no-first-run --no-default-browser-check --disable-sync`;
  const command = `$s = New-Object -ComObject Shell.Application; $s.ShellExecute('${edge.replaceAll("'", "''")}', '${args.replaceAll("'", "''")}', '', '', 1)`;
  runHiddenPowershell(["-Command", command]);
  log("briefing window opened");
}

function showToast(title, body) {
  runHiddenPowershell(["-File", path.join(ROOT, "runtime", "toast.ps1")], {
    SBHNEWS_TOAST_TITLE: title,
    SBHNEWS_TOAST_BODY: body,
  });
  log("toast shown");
}

function presentResult(finalCode) {
  if (process.argv.includes("--check-classifier")) return;
  if ((finalCode === 1 || finalCode === 2 || finalCode === 3) && logFile) {
    fs.copyFileSync(logFile, path.join(LOG_DIR, "last-failure.log"));
  }
  if (finalCode === 0) {
    if (suppressPopup) {
      log("popup skipped");
      return;
    }
    showBriefingWindow();
    const toastTitle = briefingMode === "urgent" ? "Meridian 긴급 이슈" : "Meridian";
    const toastBody = briefingMode === "urgent"
      ? `긴급 이슈 ${lastIssueCount}건`
      : appendSummary
        ? appendSummary
        : preservedBriefing
          ? "추가 신규 기사 0건. 오늘 브리핑은 유지됩니다."
          : `오늘의 브리핑이 생성되었습니다. / 주요 이슈 ${lastIssueCount}건`;
    showToast(toastTitle, toastBody);
    return;
  }
  if (finalCode === 1 || finalCode === 2 || finalCode === 3) {
    showToast("Meridian 브리핑 생성 실패", `로그: ${path.join(LOG_DIR, "latest.log")}`);
  }
}

function startLog() {
  ensureDirs();
  logFile = path.join(LOG_DIR, "latest.log");
  fs.writeFileSync(logFile, "", "utf8");
  log("pipeline start");
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  log(`exit=${code}`);
  let finalCode = code;
  if (logFile) {
    const bytes = fs.readFileSync(logFile);
    const text = bytes.toString("utf8");
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (hasBom || !text.includes("한글 로그 확인")) finalCode = code === 0 ? 1 : code;
  }
  releaseLock();
  try {
    presentResult(finalCode);
  } catch (error) {
    log(`notify failed: ${String(error.message).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  process.exit(finalCode);
}

async function main() {
  hardTimeout = setTimeout(() => {
    if (!logFile) startLog();
    log("TIMEOUT");
    log("한글 로그 확인");
    killChildren();
    if (!briefingSaved) writeFailure(seoulParts(), "TIMEOUT");
    finish(3);
  }, timeoutMs());

  try {
    const removedStale = claimLock();
    startLog();
    if (removedStale) log("STALE_LOCK_REMOVED");
    await checkAuth();
    if (process.argv.includes("--check-classifier")) {
      await checkClassifier();
      log("한글 로그 확인");
      finish(0);
      return;
    }
    const code = await pipeline();
    log("한글 로그 확인");
    finish(code);
  } catch (error) {
    const code = error.code === "AUTH" ? 2 : error.code === "LOCK_HELD" ? 4 : 1;
    if (error.code !== "LOCK_HELD") {
      if (!logFile) startLog();
      log(error.code === "AUTH" ? error.message : `failed: ${error.message}`);
      log("한글 로그 확인");
      if (!briefingSaved) writeFailure(seoulParts(), error.message);
    } else {
      ensureDirs();
      fs.appendFileSync(
        path.join(LOG_DIR, "skipped.log"),
        `[${seoulParts().stamp}] SKIPPED_ALREADY_RUNNING\n`,
        "utf8",
      );
    }
    finish(code);
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
