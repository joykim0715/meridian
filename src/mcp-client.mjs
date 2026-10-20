import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { nodeExecutable, rssServerPath } from "./paths.mjs";

// rss-news.cmd is a batch wrapper. Piping MCP stdio through cmd.exe drops or
// mixes messages, so the client starts the same server entrypoint with node.
export function openRssClient() {
  const child = spawn(nodeExecutable(), [rssServerPath()], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });

  let nextId = 1;
  const pending = new Map();
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id == null || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }
    waiter.resolve(message.result);
  });

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async function start() {
    await request(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "sbhnews-daily", version: "1.0.0" },
      },
      20000,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async function callTool(name, args, timeoutMs = 60000) {
    const result = await request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    if (result?.isError) {
      const text = (result.content || []).map((item) => item.text || "").join("\n");
      throw new Error(text || `${name} failed`);
    }
    const text = (result?.content || []).find((item) => item.type === "text")?.text;
    if (!text) throw new Error(`${name} returned empty content`);
    return JSON.parse(text);
  }

  async function close() {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("MCP client closed"));
    }
    pending.clear();
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill();
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    child,
    start,
    callTool,
    close,
    stderr: () => stderr,
  };
}
