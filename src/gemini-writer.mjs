import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";

const DEFAULT_MODEL = "gemini-3.8-flash";

export function writerKind(env = process.env) {
  const raw = String(env.SBHNEWS_WRITER ?? "cursor").trim().toLowerCase();
  if (raw === "" || raw === "cursor") return "cursor";
  if (raw === "gemini") return "gemini";
  throw new Error(`SBHNEWS_WRITER 를 모른다: ${raw}`);
}

export function loadDotEnv(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] != null && env[key] !== "") continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

function authError(message) {
  const error = new Error(message);
  error.code = "AUTH";
  return error;
}

export function geminiConfig(env = process.env) {
  loadDotEnv(path.join(ROOT, ".env"), env);
  const key = String(env.GEMINI_API_KEY ?? "").trim();
  if (!key) throw authError("GEMINI_API_KEY 가 없다");
  const model = String(env.GEMINI_MODEL ?? "").trim() || DEFAULT_MODEL;
  return { key, model };
}

export function parseModelJson(text) {
  const source = String(text ?? "");
  const start = source.lastIndexOf("BEGIN_JSON");
  const end = source.lastIndexOf("END_JSON");
  let block = source;
  if (start !== -1 && end > start) block = source.slice(start + "BEGIN_JSON".length, end);
  block = block.replace(/```(?:json)?/gi, "").trim();
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) throw new Error("model JSON object missing");
  return JSON.parse(block.slice(jsonStart, jsonEnd + 1));
}

export function buildClassifyPrompt({ spec, unread, existing = "", reminder = "" }) {
  const parts = [
    spec.trim(),
    "",
    "입력 기사 JSON:",
    unread.trim(),
  ];
  if (existing.trim()) {
    parts.push("", "기존 이슈 JSON. 같은 사건이면 attachTo에 그 title을 그대로 쓴다. 다른 사건이면 attachTo는 빈 문자열이다.", existing.trim());
  }
  parts.push("", "위 규칙과 입력만 사용한다. 다른 자료는 보지 않는다. 출력은 BEGIN_JSON 과 END_JSON 사이의 JSON 하나만.");
  if (reminder.trim()) parts.push(reminder.trim());
  return parts.join("\n");
}

export function buildStrategyPrompt({ spec, snapshot, reminder = "" }) {
  const parts = [
    spec.trim(),
    "",
    "입력 스냅샷 JSON:",
    snapshot.trim(),
    "",
    "위 규칙과 입력만 사용한다. 다른 자료는 보지 않는다. 출력은 BEGIN_JSON 과 END_JSON 사이의 JSON 하나만.",
  ];
  if (reminder.trim()) parts.push(reminder.trim());
  return parts.join("\n");
}

function responseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => part && part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function geminiComplete(prompt, timeoutMs = 8 * 60 * 1000, env = process.env) {
  const { key, model } = geminiConfig(env);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) throw new Error(`gemini http ${response.status}`);
  const text = responseText(await response.json());
  if (!text) throw new Error("gemini empty output");
  return text;
}

export async function assertGeminiReady(env = process.env) {
  const { key, model } = geminiConfig(env);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
    { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw authError(`GEMINI_AUTH_FAILED http ${response.status}`);
}
