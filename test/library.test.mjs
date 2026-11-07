import test from "node:test";
import assert from "node:assert/strict";
import {
  json, empty, signedIn, setup, track, me,
} from "./helpers.mjs";

test("own playlists list their items; others explain why they can't", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/me") return json(me);
    if (path === "/v1/playlists/mine") {
      return json({
        id: "mine", name: "Mine", owner: { id: "listener" },
        items: { total: 3, items: [{ item: track("a") }, { item: null }], next: "https://api.spotify.com/v1/playlists/mine/items?offset=2" },
      });
    }
    if (path === "/v1/playlists/mine/items") {
      return json({ items: [{ item: { ...track(null), is_local: true, uri: "spotify:local:x:y:z:1" } }], next: null });
    }
    return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, description: "Hits &amp; more", items: { total: 30 } });
  }, { saved: signedIn() });
  const mine = await plugin.playlist({ id: "mine" });
  assert.equal(mine.mine, true);
  assert.deepEqual(mine.tracks.map((t) => [t.id, !!t.unavailable]), [
    ["a", false], ["missing:1", true], [`local:${encodeURIComponent("spotify:local:x:y:z:1")}`, true],
  ]);
  assert.equal(mine.tracks[0].album.imageUrl, "https://i.scdn.co/640");
  const theirs = await plugin.playlist({ id: "theirs" });
  assert.equal(theirs.saved, true);
  assert.deepEqual(theirs.tracks, []);
  assert.match(theirs.description, /^Hits & more\nSpotify lets this plugin/);
});

test("library reads and writes go through /me/library in batches of 40", async () => {
  const seen = [];
  const { plugin } = await setup((call) => {
    seen.push([call.method, call.url.pathname, call.url.searchParams.get("uris")]);
    if (call.url.pathname === "/v1/me/library/contains") {
      return json(call.url.searchParams.get("uris").split(",").map((uri) => uri.endsWith("1")));
    }
    return empty(200);
  }, { saved: signedIn() });
  const ids = [...Array.from({ length: 45 }, (_, i) => `t${i}`), "episode:e1", "missing:3"];
  const answer = await plugin.isLiked({ ids });
  assert.equal(seen.length, 2);
  assert.equal(seen[0][2].split(",").length, 40);
  assert.equal(answer.t1, true);
  assert.equal(answer.t2, false);
  assert.equal(answer["episode:e1"], true);
  assert.equal(answer["missing:3"], false);
  await plugin.like({ id: "t9", on: true });
  await plugin.likeEpisode({ id: "episode:e1", on: false });
  await plugin.saveAlbum({ id: "alb", on: true });
  assert.deepEqual(seen.slice(2), [
    ["PUT", "/v1/me/library", "spotify:track:t9"],
    ["DELETE", "/v1/me/library", "spotify:episode:e1"],
    ["PUT", "/v1/me/library", "spotify:album:alb"],
  ]);
  await assert.rejects(plugin.like({ id: "missing:3", on: true }), { code: "unsupported" });
});

test("playlist edits use /items, and moves match the app's final index", async () => {
  const bodies = [];
  const { plugin } = await setup((call) => {
    bodies.push([call.method, call.url.pathname, JSON.parse(call.body)]);
    return json({ snapshot_id: "s" });
  }, { saved: signedIn() });
  await plugin.addToPlaylist({ id: "pl", trackIds: ["a", "a", "episode:e"] });
  await plugin.removeFromPlaylist({ id: "pl", trackIds: ["a", `local:${encodeURIComponent("spotify:local:x")}`] });
  await plugin.movePlaylistTrack({ id: "pl", from: 1, to: 3 });
  await plugin.movePlaylistTrack({ id: "pl", from: 3, to: 0 });
  assert.deepEqual(bodies, [
    ["POST", "/v1/playlists/pl/items", { uris: ["spotify:track:a", "spotify:episode:e"] }],
    ["DELETE", "/v1/playlists/pl/items", { items: [{ uri: "spotify:track:a" }, { uri: "spotify:local:x" }] }],
    ["PUT", "/v1/playlists/pl/items", { range_start: 1, insert_before: 4, range_length: 1 }],
    ["PUT", "/v1/playlists/pl/items", { range_start: 3, insert_before: 0, range_length: 1 }],
  ]);
});

test("adding a local file to a playlist says Spotify can't", async () => {
  const { plugin } = await setup(() => json({}), { saved: signedIn() });
  await assert.rejects(
    plugin.addToPlaylist({ id: "pl", trackIds: [`local:${encodeURIComponent("spotify:local:x")}`] }),
    { code: "unsupported", message: /local files/ },
  );
});
