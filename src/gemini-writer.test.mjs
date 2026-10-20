import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClassifyPrompt,
  buildStrategyPrompt,
  loadDotEnv,
  parseModelJson,
  writerKind,
} from "./gemini-writer.mjs";

test("writer defaults to cursor and accepts gemini", () => {
  assert.equal(writerKind({}), "cursor");
  assert.equal(writerKind({ SBHNEWS_WRITER: "gemini" }), "gemini");
  assert.throws(() => writerKind({ SBHNEWS_WRITER: "gpt" }), /모른다/);
});

test("dotenv fills only missing keys", () => {
  const file = path.join(os.tmpdir(), `sbh-env-${process.pid}.env`);
  fs.writeFileSync(file, "GEMINI_API_KEY=from-file\nALREADY=file\n# note\n\n", "utf8");
  const env = { ALREADY: "kept" };
  loadDotEnv(file, env);
  assert.equal(env.GEMINI_API_KEY, "from-file");
  assert.equal(env.ALREADY, "kept");
  fs.unlinkSync(file);
});

test("model json accepts markers, fences, or a bare object", () => {
  assert.deepEqual(parseModelJson('BEGIN_JSON\n{"issues":[]}\nEND_JSON'), { issues: [] });
  assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.equal(parseModelJson('{"stance":"유지"}').stance, "유지");
});

test("classify prompt carries the article and the spec, not a key", () => {
  const prompt = buildClassifyPrompt({
    spec: "기사에 없음",
    unread: '{"entryUid":"u-1","title":"예멘"}',
    existing: '{"title":"기존"}',
    reminder: "Return corrected JSON only.",
  });
  assert.match(prompt, /기사에 없음/);
  assert.match(prompt, /u-1/);
  assert.match(prompt, /기존/);
  assert.match(prompt, /BEGIN_JSON/);
  assert.equal(prompt.includes("GEMINI_API_KEY"), false);
});

test("strategy prompt carries the snapshot numbers", () => {
  const prompt = buildStrategyPrompt({
    spec: "목표 가격은 만들지 않는다.",
    snapshot: '{"basket":[{"name":"S&P500","quote":{"price":7690.73}}]}',
  });
  assert.match(prompt, /7690\.73/);
  assert.match(prompt, /목표 가격은 만들지 않는다/);
});
