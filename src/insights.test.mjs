// node src/insights.test.mjs
// The summarizers turn TikTok's nested insight payloads into the fields analysis reads;
// a shape slip here silently stores nulls every week. Fixtures are trimmed real payloads.
import assert from "node:assert";
import { summarizeTikTokAccount, summarizeTikTokPost } from "./platforms/tiktok.js";

const acct = summarizeTikTokAccount({
  follower_num: { status: 0, value: 30 },
  vv_history: [{ status: 0, value: 245 }, { status: 0, value: 12 }],
  viewer_age_distribution: { status: 0, value: [{ key: "18-24", value: 0.289 }, { key: "25-34", value: 0.494 }] },
  viewer_country_city_percent: { country_percent_list: [
    { country_name: "CA", country_vv_percent: 0.5, city_percent_list: [{ key: "Surrey", value: 0.47 }] }] },
  viewer_active_history_hours: [{ status: 0, value: Array(24).fill(10) }, { status: 0, value: Array(24).fill(20) }],
  follower_location_percent: { country_percent_list: null, status: 2 },
  user_search_terms: { status: 0, value: [{ key: "acme", value: 0.444 }] },
});
assert.deepStrictEqual(acct.search_terms, { acme: 0.444 });
assert.strictEqual(acct.followers, 30);
assert.strictEqual(acct.views_28d, 257);
assert.deepStrictEqual(acct.age, { "18-24": 0.289, "25-34": 0.494 });
assert.deepStrictEqual(acct.locations, [{ country: "CA", pct: 0.5, cities: { Surrey: 0.47 } }]);
assert.strictEqual(acct.active_hours[5], 15, "hours average across days");
assert.strictEqual(acct.follower_locations, null, "status 2 (not enough data) is null, not a crash");

const post = summarizeTikTokPost(
  { desc: "hi", duration: 22600, play_count: "74", like_count: "1", comment_count: "0", share_count: "0", favorite_count: "1" },
  { video_per_duration_realtime: { value: { status: 0, value: 2.67 } },
    video_viewer_age_percent_realtime: { value: { status: 0, value: [{ key: "25-34", value: 0.47 }] } },
    video_retention_rate_realtime: { value: { list: [{ timestamp: "0", value: 1 }, { timestamp: "1000", value: 0.57 }] } } });
assert.strictEqual(post.views, 74);
assert.strictEqual(post.duration_s, 22.6);
assert.strictEqual(post.avg_watch_s, 2.67);
assert.deepStrictEqual(post.age, { "25-34": 0.47 });
assert.deepStrictEqual(post.retention, [[0, 1], [1, 0.57]]);
assert.strictEqual(summarizeTikTokPost({ duration: 1000 }, null).avg_watch_s, null, "shallow post has no analytics");
console.log("insights summarizers ok");
