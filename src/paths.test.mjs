import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT, cursorAgentPath, edgeExecutable, rssServerPath } from "./paths.mjs";

test("root follows the install folder", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src", "run-daily.mjs")), true);
});

test("tool lookup returns a real file when that tool is installed", () => {
  for (const lookup of [cursorAgentPath, rssServerPath, edgeExecutable]) {
    try {
      assert.equal(fs.existsSync(lookup()), true);
    } catch (error) {
      assert.match(String(error.message), /찾지 못했다/);
    }
  }
});
