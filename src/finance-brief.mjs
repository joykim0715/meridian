import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";
const SNAPSHOT_PATH = path.join(ROOT, "finance", "output", "finance_snapshot.json");
const BOARD_PATH = path.join(ROOT, "runtime", "finance-board.json");
const STATUS_PATH = path.join(ROOT, "runtime", "finance-brief-status.json");

const GROUPS = [
  ["변동성", ["cboe:VIX", "cboe:VIX9D", "cboe:VVIX", "fred:VIXCLS"]],
  ["금리와 신용", ["fred:DGS2", "fred:DGS10", "fred:T10Y2Y", "fred:BAMLH0A0HYM2", "fred:FEDFUNDS"]],
  ["환율과 유동성", ["fred:DEXKOUS", "fred:DTWEXBGS", "fred:WALCL", "fred:USREC"]],
];

function redact(text) {
  return String(text ?? "").replace(/(api_key|apikey|AUTH_KEY|appsecret|appkey|secret)=([^&\s]+)/gi, "$1=***");
}

function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, {
      cwd: ROOT,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(child.pid);
      } catch {
        // The process already exited.
      }
      reject(new Error("finance timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr: redact(stderr).slice(0, 300) });
    });
  });
}

function writeStatus(ok, message) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ ok, message })}\n`, "utf8");
}

export function readFinanceBoard() {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, "utf8"));
  } catch {
    return { heroes: [], rows: [], missing: [], clockNote: "" };
  }
}

export function readFinanceSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return { ok: false, message: "이번 실행에서 새로 갱신하지 않았다. 마지막 저장분을 표시한다." };
  }
}

function formatValue(item) {
  const value = item.latest_close;
  if (value == null) return "값 없음";
  if (item.unit === "percent" || item.price_kind === "yield_percent" || item.price_kind === "spread_percent") {
    return `${value}%`;
  }
  if (item.unit === "flag") {
    if (value === 0) return "0, 확장기";
    if (value === 1) return "1, 침체";
  }
  if (item.unit === "KRW_per_USD") return `${value}원/달러`;
  if (item.unit === "millions_usd") return `${value}백만 달러`;
  if (item.unit === "index") return `${value}`;
  return `${value} ${item.unit || ""}`.trim();
}

function qualitySuffix(item) {
  const quality = item.quality || [];
  const errors = quality.filter((issue) => issue.severity === "error").length;
  const warnings = quality.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
  const parts = [];
  if (errors) parts.push(`검증 오류 ${errors}건`);
  parts.push(...warnings);
  return parts.length ? ` ${parts.join(". ")}` : "";
}

export function renderFinanceBrief(snapshot, status) {
  const lines = [
    "# 수집 금융 데이터",
    "",
    `- 스냅샷 시각: ${snapshot?.generated_at || "없음"}`,
    `- 갱신: ${status?.message || "상태 없음"}`,
    "",
  ];
  if (!snapshot) {
    lines.push("저장된 금융 스냅샷이 없다. 뉴스 브리핑은 그대로 표시한다.", "");
    return lines.join("\n");
  }
  const byId = new Map((snapshot.instruments || []).map((item) => [item.instrument_id, item]));
  for (const [title, ids] of GROUPS) {
    const rows = ids.map((id) => byId.get(id)).filter((item) => item && item.observations > 0);
    lines.push(`## ${title}`, "");
    if (!rows.length) {
      lines.push("- 이 묶음에서 저장된 수치가 없다.", "");
      continue;
    }
    for (const item of rows) {
      lines.push(`- ${item.name}: ${formatValue(item)}, 관측일 ${item.latest_obs_date}${qualitySuffix(item)}`);
    }
    lines.push("");
  }
  lines.push("VIX와 VIXCLS는 예상 변동성이다. 가격의 방향이 아니다. 두 시계열은 합치지 않는다.", "");
  lines.push("## 아직 없는 데이터", "");
  const missing = snapshot.missing || [];
  if (missing.length) {
    for (const note of missing) lines.push(`- ${note}`);
  } else {
    lines.push("- 없음");
  }
  lines.push("");
  return lines.join("\n");
}

export function loadFinanceMarkdown() {
  return renderFinanceBrief(readFinanceSnapshot(), readStatus());
}

export async function refreshFinanceForBriefing() {
  try {
    const update = await runPython(["-m", "finance", "update"], 90000);
    if (update.code !== 0) {
      writeStatus(false, `이번 갱신은 실패했다. 마지막 저장분을 표시한다. ${update.stderr}`.trim());
    } else {
      const snapshotRun = await runPython(["-m", "finance", "snapshot"], 30000);
      writeStatus(snapshotRun.code === 0, snapshotRun.code === 0
        ? "이번 창을 열기 전에 수집을 갱신했다."
        : "수집은 끝났으나 스냅샷을 다시 쓰지 못했다. 마지막 저장분을 표시한다.");
    }
  } catch (error) {
    writeStatus(false, `이번 갱신은 실패했다. 마지막 저장분을 표시한다. ${redact(error.message)}`.trim());
  }
  return loadFinanceMarkdown();
}
