import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessImpact } from "./event-impact.mjs";

const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime", "display.template.html");
const advicePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "order-advice.mjs");

function embed(value) {
  return JSON.stringify(String(value ?? ""))
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderDisplayDocument(markdown, strategy = "", finance = "", board = null) {
  const template = fs.readFileSync(templatePath, "utf8");
  if (!template.includes("__SOURCE__") || !template.includes("__STRATEGY__") || !template.includes("__FINANCE__") || !template.includes("__BOARD__") || !template.includes("__IMPACT__") || !template.includes("__ADVICE_JS__")) {
    throw new Error("display template missing source slot");
  }
  const impact = assessImpact(markdown, board || {});
  const adviceJs = fs.readFileSync(advicePath, "utf8").replace(/^export /gm, "");
  return template
    .replace("__SOURCE__", () => embed(markdown))
    .replace("__STRATEGY__", () => embed(strategy))
    .replace("__FINANCE__", () => embed(finance))
    .replace("__BOARD__", () => embed(JSON.stringify(board || { heroes: [], rows: [], missing: [], clockNote: "" })))
    .replace("__IMPACT__", () => embed(JSON.stringify(impact)))
    .replace("__ADVICE_JS__", () => adviceJs);
}
