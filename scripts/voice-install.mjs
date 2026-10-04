// cc's offline voice: a Python venv in voice/venv with Kokoro (kokoro-onnx + onnxruntime),
// and the Kokoro v1.0 model files (about 340 MB, from the kokoro-onnx project's releases).
//
//   npm run voice:install
//
// cc starts the voice server (scripts/voice.py) by itself once this is in place, and uses
// the Windows voice until then. Re-running skips what is already there.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ROOT, config, tool } from "../src/config.js";

const DIR = join(ROOT, "voice");
const VENV_PY = join(DIR, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
const FILES = [["kokoro-v1.0.onnx", 300e6], ["voices-v1.0.bin", 20e6]];   // name, smallest believable size
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" });

mkdirSync(DIR, { recursive: true });
if (!existsSync(VENV_PY)) {
  console.log("Creating voice/venv ...");
  if (run(tool(config.paths.python), ["-m", "venv", join(DIR, "venv")]).status !== 0) { console.log("Couldn't create the venv; check paths.python in studio.config.json."); process.exit(1); }
}
console.log("Installing Kokoro into voice/venv ...");
if (run(VENV_PY, ["-m", "pip", "install", "--upgrade", "kokoro-onnx", "onnxruntime", "soundfile", "numpy"]).status !== 0) process.exit(1);

for (const [name, min] of FILES) {
  const dest = join(DIR, name);
  if (existsSync(dest) && statSync(dest).size >= min) { console.log(`${name}: already here`); continue; }
  console.log(`Downloading ${name} ...`);
  const res = await fetch(`${RELEASE}/${name}`);
  if (!res.ok) { console.log(`Download failed (${res.status}). Get it from ${RELEASE}/${name} into voice/.`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dest}.part`));
  if (statSync(`${dest}.part`).size < min) { console.log(`${name} came down incomplete; run again.`); process.exit(1); }
  renameSync(`${dest}.part`, dest);
}
const test = spawnSync(VENV_PY, ["-c", "import kokoro_onnx, onnxruntime, soundfile; print('ok')"], { encoding: "utf8" });
console.log(test.stdout?.includes("ok") ? "\ncc's offline voice is ready. cc starts it on its next line." : `\nThe voice packages didn't import:\n${test.stderr}`);
process.exit(test.status ?? 1);
