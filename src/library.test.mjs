// node src/library.test.mjs
// The duplicate judgement decides whether a finished render is allowed to post.
// A false BLOCK stops the channel; a missed BLOCK posts the same video twice.
import assert from "node:assert";
import { judge, hamming, COOLDOWN } from "./library.js";

const H = (c) => c.repeat(48);                 // a 192-bit hash of one repeated nibble
const now = new Date("2026-09-11T12:00:00Z");
const ago = (d) => new Date(now - d * 86_400_000).toISOString();

assert.strictEqual(hamming("ff", "ff"), 0);
assert.strictEqual(hamming("0", "f"), 4);
assert.strictEqual(hamming("ff", null), null, "an unhashable video is not a match");
assert.strictEqual(hamming("ff", "fff"), null, "hashes of different length never compare");

const item = { sha: "aaa", phash: H("0") };
const prior = (o) => ({ key: "mybrand-tiktok-2026-09-01-001", sha: "bbb", phash: H("0"), account: "mybrand-tiktok", at: ago(1), ...o });

// Exact file, same account: block regardless of how long ago it went out.
assert.deepStrictEqual(
  judge(item, "mybrand-tiktok", [prior({ sha: "aaa", at: ago(400) })], now).map((f) => f.level),
  ["BLOCK"]);

// Exact file, another account: a warning inside the cross-account cooldown, silent after.
assert.deepStrictEqual(
  judge(item, "mybrand-instagram", [prior({ sha: "aaa", at: ago(1) })], now).map((f) => f.level), ["WARN"]);
assert.deepStrictEqual(
  judge(item, "mybrand-instagram", [prior({ sha: "aaa", at: ago(30) })], now), []);

// Near-duplicate: identical frames, different bytes — warn on the same account
// inside the 14d cooldown, and stay quiet once the cooldown has passed.
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [prior({ at: ago(2) })], now).map((f) => f.level), ["WARN"]);
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [prior({ at: ago(20) })], now), []);

// A visually unrelated video is never flagged: every nibble differs.
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [prior({ phash: H("f"), at: ago(1) })], now), []);

// Right at the threshold: 4% of 192 bits is 7.68, so 7 differing bits warn and 8 do not.
const near = (bits) => "1".repeat(bits) + "0".repeat(48 - bits);   // "1" differs from "0" in one bit
assert.strictEqual(hamming(item.phash, near(7)), 7);
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [prior({ phash: near(7), at: ago(1) })], now).map((f) => f.level), ["WARN"]);
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [prior({ phash: near(8), at: ago(1) })], now), []);

// Cooldowns are configurable per project.
assert.deepStrictEqual(
  judge(item, "mybrand-tiktok", [prior({ at: ago(20) })], now, { ...COOLDOWN, same_account_days: 30 }).map((f) => f.level),
  ["WARN"]);

// An empty library never blocks anything.
assert.deepStrictEqual(judge(item, "mybrand-tiktok", [], now), []);

console.log("library: ok");
