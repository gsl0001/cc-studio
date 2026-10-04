// Build cc's avatar layers into cc-avatar/ (scripts/cc-avatar.py with your configured Python).
//
//   npm run avatar
//
// cc must not be running while this runs (it holds cc-avatar/cc.ico); it is stopped and
// started again for you when it was running as the "cc-studio cc" task.
import { spawnSync } from "node:child_process";
import { config, tool } from "../src/config.js";

const py = tool(config.paths.python);
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
const check = sh(py, ["-c", "import cv2, numpy, PIL"]);
if (check.status !== 0) {
  console.log(`${py} is missing opencv-python, numpy or pillow:\n  ${py} -m pip install opencv-python numpy pillow`);
  process.exit(1);
}
const running = process.platform === "win32" && sh("schtasks", ["/query", "/tn", "cc-studio cc", "/fo", "csv", "/nh"]).stdout?.includes("Running");
if (running) sh("schtasks", ["/end", "/tn", "cc-studio cc"]);
const r = spawnSync(py, ["scripts/cc-avatar.py"], { stdio: "inherit" });
if (running) sh("schtasks", ["/run", "/tn", "cc-studio cc"]);
process.exit(r.status ?? 1);
