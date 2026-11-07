import test from "node:test";
import assert from "node:assert/strict";
import {
  empty, signedIn, setup, lyricsSources,
} from "./helpers.mjs";

test("lyrics prefer LRCLIB, which follows Spotify's titles, and are cached", async () => {
  const { handler, seen } = lyricsSources({
    lrclibGet: { syncedLyrics: "[00:21.78] 翻手為雲 覆手為雨" },
    neteaseSongs: [{ id: 28854182, dt: 256418 }],
    neteaseLyric: { lrc: { lyric: "[00:21.99]翻手为云覆手为雨" } },
  });
  const { plugin, calls } = await setup(handler, { saved: signedIn() });
  assert.deepEqual(await plugin.lyrics({ id: "t1" }), { lrc: "[00:21.78] 翻手為雲 覆手為雨", translation: "" });
  const get = calls.find((c) => c.url.pathname === "/api/get").url.searchParams;
  assert.deepEqual([get.get("track_name"), get.get("artist_name"), get.get("album_name"), get.get("duration")], ["驚鴻一面", "許嵩", "不如吃茶去", "256"]);
  const count = seen.length;
  await plugin.lyrics({ id: "t1" });
  assert.equal(seen.length, count);
});

test("NetEase wins when it has a translation", async () => {
  const { handler } = lyricsSources({
    lrclibGet: { syncedLyrics: "[00:01.00] Hello" },
    neteaseSongs: [{ id: 1, dt: 256000 }],
    neteaseLyric: { lrc: { lyric: "[00:01.00]Hello" }, tlyric: { lyric: "[00:01.00]你好" } },
  });
  const { plugin } = await setup(handler, { saved: signedIn() });
  assert.deepEqual(await plugin.lyrics({ id: "t1" }), { lrc: "[00:01.00]Hello", translation: "[00:01.00]你好" });
});

test("a NetEase song of another length isn't taken, and LRCLIB search is the fallback", async () => {
  const { handler, seen } = lyricsSources({
    lrclibSearch: [{ duration: 300, syncedLyrics: "[00:01.00] wrong" }, { duration: 256, syncedLyrics: "[00:01.00] right" }],
    neteaseSongs: [{ id: 2, dt: 263340 }],
  });
  const { plugin } = await setup(handler, { saved: signedIn() });
  assert.equal((await plugin.lyrics({ id: "t1" })).lrc, "[00:01.00] right");
  assert.ok(!seen.some((s) => s.endsWith("/api/song/lyric")));
});

test("no lyrics anywhere is empty; both sources offline is an error; one offline is fine", async () => {
  let ctx = await setup(lyricsSources().handler, { saved: signedIn() });
  assert.deepEqual(await ctx.plugin.lyrics({ id: "t1" }), { lrc: "", translation: "" });
  ctx = await setup(lyricsSources({ fail: ["lrclib.net", "music.163.com"] }).handler, { saved: signedIn() });
  await assert.rejects(ctx.plugin.lyrics({ id: "t1" }), /Couldn't load lyrics/);
  ctx = await setup(lyricsSources({ fail: ["lrclib.net"], neteaseSongs: [{ id: 1, dt: 256470 }], neteaseLyric: { lrc: { lyric: "[00:01.00]词" } } }).handler, { saved: signedIn() });
  assert.equal((await ctx.plugin.lyrics({ id: "t1" })).lrc, "[00:01.00]词");
});

test("episodes and local files have no lyrics to look up", async () => {
  const { plugin, calls } = await setup(() => assert.fail("fetched"), { saved: signedIn() });
  for (const id of ["episode:e1", "local:x", "missing:1"]) assert.deepEqual(await plugin.lyrics({ id }), { lrc: "", translation: "" });
  assert.equal(calls.length, 0);
});


test("lyrics missing because a source failed are looked up again next time", async () => {
  let failing = true;
  const sources = lyricsSources({ lrclibGet: { syncedLyrics: "[00:01.00] words" } });
  const { plugin } = await setup((call) => {
    if (failing && call.url.host === "lrclib.net") throw new Error("offline");
    return sources.handler(call);
  }, { saved: signedIn() });
  assert.equal((await plugin.lyrics({ id: "t1" })).lrc, "");
  failing = false;
  assert.equal((await plugin.lyrics({ id: "t1" })).lrc, "[00:01.00] words");
});
