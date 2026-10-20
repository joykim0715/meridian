import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

export function nodeExecutable() {
  return process.execPath;
}

export function rssServerPath() {
  const appData = process.env.APPDATA || "";
  const found = firstExisting([
    process.env.SBHNEWS_RSS_SERVER,
    path.join(ROOT, "node_modules", "@max1ab", "rss-news", "dist", "index.js"),
    appData && path.join(appData, "npm", "node_modules", "@max1ab", "rss-news", "dist", "index.js"),
  ]);
  if (!found) {
    throw new Error("rss-news를 찾지 못했다. 프로젝트에서 npm install 을 실행하거나 SBHNEWS_RSS_SERVER 를 지정한다.");
  }
  return found;
}

export function cursorAgentPath() {
  const local = process.env.LOCALAPPDATA || "";
  const found = firstExisting([
    process.env.CURSOR_AGENT,
    local && path.join(local, "cursor-agent", "agent.cmd"),
  ]);
  if (!found) {
    throw new Error("Cursor CLI를 찾지 못했다. 그 PC에 Cursor CLI 로그인 후 CURSOR_AGENT 로 경로를 지정할 수 있다.");
  }
  return found;
}

export function edgeExecutable() {
  const found = firstExisting([
    process.env.SBHNEWS_EDGE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
  if (!found) throw new Error("Microsoft Edge를 찾지 못했다. SBHNEWS_EDGE 로 msedge.exe 경로를 지정한다.");
  return found;
}
