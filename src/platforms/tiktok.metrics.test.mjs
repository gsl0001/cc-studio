// node src/platforms/tiktok.metrics.test.mjs
// Row text below is verbatim from a real Studio dump (scripts/studio-posts-all.mjs).
import assert from "node:assert";
import { parseStudioRows } from "./tiktok.js";

const rows = [
  "03:54\nLumen-free sleep sound mixer #sleepsounds #rain\nAug 18, 11:36 PM\nEveryone\n269\n22\n0",
  "00:12\ngentle rain first, brown noise underneath #lumen #rainsounds\nAug 10, 12:00 PM\nEveryone\n1.2K\n8\n0",
  "00:22\nnot one of ours\nAug 26, 6:00 PM\nEveryone\n0\n0\n0",
  "00:22\nheader junk with no stats\nAug 26, 6:00 PM\nEveryone",
];
const jobs = [
  { key: "a", caption: "Lumen-free sleep sound mixer #sleepsounds #rain" },
  { key: "b", caption: "gentle rain first, brown noise underneath #lumen #rainsounds" },
  { key: "c", caption: null },
];

assert.deepStrictEqual(parseStudioRows(rows, jobs), [
  { key: "a", views: 269, likes: 22, comments: 0, shares: 0 },
  { key: "b", views: 1200, likes: 8, comments: 0, shares: 0 },
]);
console.log("ok");

// parseRetention — text verbatim from a real analytics overview page (probe 2026-08-22).
import { parseRetention } from "./tiktok.js";
const page = "Video views\n269\nTotal play time\n0h:12m:22s\nAverage watch time\n2.3s\nWatched full video\n0%\nNew followers\n0\nRetention rate\nMost viewers stopped watching at 0:01. Play the video below to see when they lost interest.";
assert.deepStrictEqual(parseRetention(page), { avg_watch_s: 2.3, full_watch_pct: 0, stop_at_s: 1 });
assert.deepStrictEqual(parseRetention("Average watch time\n1m 5s\nWatched full video\n12.5%\nstopped watching at 1:23"),
  { avg_watch_s: 65, full_watch_pct: 12.5, stop_at_s: 83 });
assert.strictEqual(parseRetention("no analytics here"), null);
console.log("retention ok");
