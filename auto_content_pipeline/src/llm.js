// One claude -p call -> parsed JSON + the model that actually answered. The prompt goes
// on stdin (argv quoting mangles it on Windows). Opus 5.5 at low effort by default; the
// CLI falls back to Sonnet on a limit, and the caller reports which one answered.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { model } from "../../src/config.js";

export const MODEL = model("strategist");
export const EFFORT = process.env.STRATEGIST_EFFORT || "low";

// The first balanced {...} object in the text — models wrap JSON in fences and prose
// that can itself contain braces. Trailing commas are stripped only when the strict
// parse fails.
export function parseJson(text, from = 0) {
  const start = text.indexOf("{", from);
  if (start < 0) throw new Error("no JSON object in model output");
  // Prose can hold braces before the real object ("Plan for {account}:"): try the next one.
  try { return parseAt(text, start); } catch (e) { if (text.indexOf("{", start + 1) >= 0) return parseJson(text, start + 1); throw e; }
}
function parseAt(text, start) {
  let depth = 0, inString = false, end = -1;
  for (let i = start; i < text.length && end < 0; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) end = i;
  }
  if (end < 0) throw new Error("unterminated JSON object in model output");
  const s = text.slice(start, end + 1);
  try { return JSON.parse(s); } catch { return JSON.parse(s.replace(/,\s*([}\]])/g, "$1")); }
}

export function askClaude(prompt, { web = false, timeoutMs = 20 * 60_000 } = {}) {
  const args = ["-p", "--model", MODEL, "--effort", EFFORT, "--fallback-model", "sonnet", "--output-format", "json"];
  if (web) args.push("--allowedTools", "WebSearch,WebFetch");
  let out;
  try {
    out = execFileSync("claude", args, { input: prompt, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs, shell: true,
      // A 3-account week is ~20k tokens of JSON; the CLI's default cap truncated it (2026-10-03).
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "64000" } });
  } catch (e) {
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const err = new Error(`claude rc=${e.status}: ${text.slice(-300).replace(/\s+/g, " ")}`);
    err.quota = /(reached|hit) your .*limit|usage limit|session limit/i.test(text);
    throw err;
  }
  const j = JSON.parse(out);
  if (j.is_error) {
    const err = new Error(`claude error: ${String(j.result).slice(0, 300)}`);
    err.quota = /(reached|hit) your .*limit|usage limit|session limit/i.test(String(j.result));
    throw err;
  }
  // modelUsage also lists the small model the CLI uses to read fetched web pages (it can
  // out-write the planner), so: the requested model if it answered, else the fallback.
  const used = Object.keys(j.modelUsage ?? {});
  const model = used.find((m) => m.startsWith(MODEL)) ?? used.find((m) => !/haiku/i.test(m)) ?? used[0] ?? MODEL;
  try {
    return { data: parseJson(j.result), model };
  } catch (e) {
    mkdirSync("logs", { recursive: true });
    const file = `logs/llm-unparsed-${Date.now()}.txt`;
    writeFileSync(file, `stop_reason=${j.stop_reason ?? "?"} chars=${String(j.result).length}

${j.result}`);
    e.message += ` (stop_reason=${j.stop_reason ?? "?"}, raw output in ${file})`;
    throw e;
  }
}
