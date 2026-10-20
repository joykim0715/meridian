const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const child = spawn(process.execPath, [path.join(root, "src", "run-daily.mjs")], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
});

child.on("error", () => process.exit(1));
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  const exitCode = code == null ? 1 : code;
  process.exit(exitCode === 4 ? 0 : exitCode);
});
