import test from "node:test";
import assert from "node:assert/strict";
import {
  json, empty, signedIn, setup, track, me, fastPolling,
} from "./helpers.mjs";

// The host asks for the next page at the number already shown. Null items
// must not make it ask for results it has already had.
test("search pages by Spotify's offset even when it drops items", async () => {
  const offsets = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    const params = call.url.searchParams;
    assert.equal(params.get("limit"), "10");
    assert.equal(params.get("type"), "playlist");
    const offset = Number(params.get("offset"));
    offsets.push(offset);
    const items = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? null : {
      id: `p${offset + i}`, name: `List ${offset + i}`, owner: { id: "someone" }, items: { total: 4 },
    }));
    return json({ playlists: { items, next: offset < 20 ? "https://api.spotify.com/v1/search?offset=x" : null } });
  }, { saved: signedIn() });
  const first = await plugin.search({ query: "mix", kind: "playlists", offset: 0 });
  assert.equal(first.playlists.length, 6);
  assert.equal(first.playlists[0].trackCount, 4);
  assert.equal(first.more, true);
  const second = await plugin.search({ query: "mix", kind: "playlists", offset: 6 });
  assert.deepEqual(offsets, [0, 10]);
  assert.equal(second.playlists[0].id, "p11");
  await plugin.search({ query: "mix", kind: "playlists", offset: 12 });
  assert.deepEqual(offsets, [0, 10, 20]);
});

test("home keeps working when one section fails", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/top/artists") return json({ error: { status: 500 } }, 500);
    if (call.url.pathname === "/v1/me/player/recently-played") return json({ items: [{ track: track("a") }, { track: track("a") }, { track: track("b") }] });
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  const home = await plugin.home();
  assert.deepEqual(home.sections[0].tracks.map((t) => t.id), ["a", "b"]);
  assert.match(home.sections[2].empty, /Couldn't load this/);
});

test("artist page finds the artist's own songs by search, without top tracks", async () => {
  const paths = [];
  const { plugin } = await setup((call) => {
    paths.push(call.url.pathname);
    if (call.url.pathname === "/v1/artists/artist1") return json({ id: "artist1", name: "Artist" });
    if (call.url.pathname === "/v1/artists/artist1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (call.url.pathname === "/v1/me/library/contains") return json([true]);
    assert.equal(call.url.searchParams.get("q"), "artist:\"Artist\"");
    return json({ tracks: { items: [track("a"), track("b", { artists: [{ id: "other" }] })], next: null } });
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "artist1" });
  assert.equal(page.artist.following, true);
  assert.deepEqual(page.tracks.map((t) => t.id), ["a"]);
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
  assert.ok(!paths.some((p) => p.endsWith("top-tracks")));
});

test("a page loads even when Spotify can't say whether it's saved", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/library/contains") return json({ error: { status: 400, message: "Unsupported type" } }, 400);
    if (call.url.pathname === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (call.url.pathname === "/v1/artists/ar1/albums") return json({ items: [], next: null });
    if (call.url.pathname === "/v1/albums/al1") return json({ id: "al1", name: "Album", tracks: { items: [track("a")], next: null } });
    return json({ tracks: { items: [], next: null } });
  }, { saved: signedIn() });
  assert.equal((await plugin.album({ id: "al1" })).album.saved, false);
  assert.equal((await plugin.artist({ id: "ar1" })).artist.following, false);
});

test("odd data doesn't break pages: bad character references, a bad local ID, an empty next page", async () => {
  let pages = 0;
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/playlists/p1") {
      return json({ id: "p1", name: "L", owner: { id: "listener" }, description: "A &#99999999; B &#x1F3B5; &amp;",
        items: { total: 5, items: [{ item: track("a") }], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" } });
    }
    pages++;
    return json({ items: [], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" });
  }, { saved: signedIn() });
  const list = await plugin.playlist({ id: "p1" });
  assert.equal(list.description, "A &#99999999; B 🎵 &");
  assert.equal(list.tracks.length, 1);
  assert.equal(pages, 1);
  await assert.rejects(plugin.removeFromPlaylist({ id: "p1", trackIds: ["local:%E0%A4%A"] }), /isn't a list of songs/);
});

test("a read that meets a passing server error is tried once more; a write isn't", async (t) => {
  fastPolling(t);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 1000 ? 0 : ms, ...args));
  let reads = 0;
  let writes = 0;
  const { plugin } = await setup((call) => {
    if (call.method === "GET") return ++reads === 1 ? json({}, 503) : json({ items: [], next: null });
    writes++;
    return json({}, 503);
  }, { saved: signedIn() });
  await plugin.liked({ offset: 0 });
  assert.equal(reads, 2);
  await assert.rejects(plugin.like({ id: "a", on: true }), /having trouble/);
  assert.equal(writes, 1);
});

test("a short rate limit is waited out once", async () => {
  let calls = 0;
  const { plugin } = await setup(() => (++calls === 1 ? json({ error: { status: 429 } }, 429, { "retry-after": "0" }) : json({ items: [], next: null })), { saved: signedIn() });
  await plugin.liked({ offset: 0 });
  assert.equal(calls, 2);
});
