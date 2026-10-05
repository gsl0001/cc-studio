// Every test, one command: the Node self-checks, then cc's speech rewrites (Windows).
//
//   npm test
import { spawnSync } from "node:child_process";

const tests = ["scripts/setup-core.mjs", "src/pause.js", "src/controls.js", "scripts/clips.mjs test", "src/platforms/tiktok.datepick.test.mjs", "src/log.test.mjs", "src/insights.test.mjs", "src/library.test.mjs", "src/platforms/tiktok.metrics.test.mjs",
  "auto_content_pipeline/tests/weekly.test.mjs"];
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, t.split(" "), { encoding: "utf8" });
  console.log(`${r.status === 0 ? "pass" : "FAIL"}  ${t}`);
  if (r.status !== 0) { failed++; console.log(`${r.stdout}${r.stderr}`.trim().split("\n").slice(-12).join("\n")); }
}
if (process.platform === "win32") {
  const r = spawnSync("powershell", ["-NoProfile", "-File", "scripts/cc-speech.test.ps1"], { encoding: "utf8" });
  console.log(`${r.status === 0 ? "pass" : "FAIL"}  scripts/cc-speech.test.ps1`);
  if (r.status !== 0) { failed++; console.log(r.stdout); }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
