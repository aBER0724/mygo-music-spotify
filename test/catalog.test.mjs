import test from "node:test";
import assert from "node:assert/strict";
import {
  json, empty, bytes, signedIn, setup, track, me, fastPolling,
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

test("an artist page keeps what loaded when Spotify limits one section", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/artist1") return json({ id: "artist1", name: "Artist" });
    if (path === "/v1/artists/artist1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    // The searches the songs section makes are the two that get turned down.
    return json({ error: { status: 429, message: "API rate limit exceeded" } }, 429);
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "artist1" });
  assert.equal(page.artist.name, "Artist");
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
  // The songs are missing, and the page is still a page.
  assert.deepEqual(page.tracks, []);
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

test("home asks only for the first playlists it shows", async () => {
  const pages = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/playlists") {
      pages.push(Number(call.url.searchParams.get("offset") || 0));
      return json({
        items: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, owner: { id: "listener" }, items: { total: 0 } })),
        next: "https://api.spotify.com/v1/me/playlists?offset=50",
      });
    }
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  await plugin.home();
  assert.deepEqual(pages, [0]);
});

test("a 404 from Spotify is unavailable, with words the listener can act on", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/library/contains") return json([false]);
    return json({ error: { status: 404, message: "non existing id" } }, 404);
  }, { saved: signedIn() });
  await assert.rejects(plugin.album({ id: "gone" }), { code: "unavailable", message: /can't find this/ });
  await assert.rejects(plugin.artist({ id: "gone" }), { code: "unavailable" });
});

test("an image without a width isn't chosen by width", async () => {
  const album = (images) => ({
    id: "al", name: "A", images,
    artists: [], release_date: "", tracks: { items: [track("a")], next: null },
  });
  let images = [{ url: "https://i.scdn.co/1000", width: 1000 }, { url: "https://i.scdn.co/no-width" }];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/library/contains") return json([false]);
    return json(album(images));
  }, { saved: signedIn() });
  assert.equal((await plugin.album({ id: "al" })).album.imageUrl, "https://i.scdn.co/1000");
  images = [{ url: "https://i.scdn.co/only" }];
  assert.equal((await plugin.album({ id: "al" })).album.imageUrl, "https://i.scdn.co/only");
});

test("descriptions are decoded once, and a plain one keeps its angle brackets", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/shows/s1") {
      return json({ id: "s1", name: "Show", description: "plain <b> text", html_description: "<p>A &#38;lt; B</p>", total_episodes: 1 });
    }
    if (call.url.pathname === "/v1/shows/s1/episodes") {
      return json({ items: [{ id: "e1", name: "Ep", description: "episode <i> plain", duration_ms: 1 }], next: null });
    }
    return json([false]);
  }, { saved: signedIn() });
  const page = await plugin.show({ id: "s1" });
  // "&#38;lt;" is the text "&lt;", not a second entity to turn into "<".
  assert.equal(page.show.description, "A &lt; B");
  assert.equal(page.episodes[0].description, "episode <i> plain");
});

test("a search keeps its place across a plugin restart, without keeping the query", async () => {
  const store = new Map();
  const offsets = [];
  const handler = (call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname !== "/v1/search") throw new Error(`unexpected ${call.url.pathname}`);
    const offset = Number(call.url.searchParams.get("offset"));
    offsets.push(offset);
    const items = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? null : {
      id: `p${offset + i}`, name: `List ${offset + i}`, owner: { id: "someone" }, items: { total: 4 },
    }));
    return json({ playlists: { items, next: offset < 20 ? "https://api.spotify.com/v1/search?offset=x" : null } });
  };
  let ctx = await setup(handler, { saved: signedIn(), store });
  const first = await ctx.plugin.search({ query: "mix", kind: "playlists", offset: 0 });
  assert.equal(first.playlists.length, 6);
  // A restarted plugin has its own module state, but the host's storage stays.
  ctx = await setup(handler, { saved: signedIn(), store });
  const second = await ctx.plugin.search({ query: "mix", kind: "playlists", offset: 6 });
  assert.deepEqual(offsets, [0, 10]);
  assert.equal(second.playlists[0].id, "p11");
  // The listener's query itself isn't kept in the plugin's storage.
  assert.ok(!JSON.stringify(store.get("searchCursors")).includes("mix"));
});

test("a search still answers when it can't save its place", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname !== "/v1/search") throw new Error(`unexpected ${call.url.pathname}`);
    return json({ tracks: { items: [track("a")], next: null } });
  }, { saved: signedIn() });
  const set = globalThis.host.storage.set;
  globalThis.host.storage.set = () => { throw new Error("disk full"); };
  try {
    const page = await plugin.search({ query: "x", kind: "tracks", offset: 0 });
    assert.deepEqual(page.tracks.map((t) => t.id), ["a"]);
  } finally {
    globalThis.host.storage.set = set;
  }
});

// --- the player identity -------------------------------------------------

// Just enough protobuf to stand in for spclient's answers.
const pbVarint = (value) => {
  const bytes = [];
  let left = value;
  while (left > 0x7f) { bytes.push((left & 0x7f) | 0x80); left = Math.floor(left / 128); }
  bytes.push(left);
  return Uint8Array.from(bytes);
};
const pbJoin = (parts) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
};
const pbBytes = (number, value) => pbJoin([pbVarint(number * 8 + 2), pbVarint(value.length), value]);
const pbString = (number, value) => pbBytes(number, new TextEncoder().encode(value));
const pbInt = (number, value) => pbJoin([pbVarint(number * 8), pbVarint(value)]);
const pbSint = (number, value) => pbInt(number, value >= 0 ? value * 2 : -value * 2 - 1);

const ALBUM_GID = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
const ARTIST_GID = Uint8Array.from([0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
  0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]);
const COVER = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]);

const playlistRows = (uris, total = uris.length) => pbJoin([
  pbInt(2, total),
  pbBytes(5, pbJoin(uris.map((uri) => pbBytes(3, pbString(1, uri))))),
]);

const entity = (uri, message) => pbBytes(3, pbJoin([
  pbString(2, uri),
  pbBytes(3, pbJoin([pbString(1, "spotify:track"), pbBytes(2, message)])),
]));
const BASE62_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const base62Of = (bytes) => {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 62; carry = Math.floor(carry / 62); }
    while (carry) { digits.push(carry % 62); carry = Math.floor(carry / 62); }
  }
  return digits.reverse().map((digit) => BASE62_DIGITS[digit]).join("").padStart(22, "0");
};
const metadataAnswer = (entries) => pbJoin(entries.map((message) => pbBytes(2, message)));

test("a playlist the Web API withholds is read from the player identity", async () => {
  const first = "0qMZXgcLfkl5RI3q50KHMH";
  const second = "41QC4JsoYNy5LwW679i6Yx";
  const track = (name, duration) => pbJoin([
    pbString(2, name),
    pbBytes(3, pbJoin([
      pbBytes(1, ALBUM_GID), pbString(2, "10,000 gecs"),
      pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
    ])),
    pbBytes(4, pbJoin([pbBytes(1, ARTIST_GID), pbString(2, "100 gecs")])),
    pbSint(7, duration),
  ]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/playlists/theirs") {
      return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, items: { total: 2 } });
    }
    if (call.url.pathname === "/playlist/v2/playlist/theirs") {
      return bytes(playlistRows([`spotify:track:${first}`, "spotify:local:CHEMOTEX:Schrade+Knives:Schrade+Knives:353", `spotify:track:${second}`]));
    }
    if (call.url.pathname === "/extended-metadata/v0/extended-metadata") {
      return bytes(metadataAnswer([
        entity(`spotify:track:${first}`, track("Dumbest Girl Alive", 200000)),
        entity(`spotify:track:${second}`, track("Residual Stress", 155000)),
      ]));
    }
    throw new Error(`unexpected ${call.url.pathname}`);
  }, { saved: signedIn(), store });

  const theirs = await plugin.playlist({ id: "theirs" });
  assert.equal(theirs.tracks.length, 3);
  assert.equal(theirs.trackCount, 3);
  assert.deepEqual(theirs.tracks.map((song) => song.id), [
    first, `local:${encodeURIComponent("spotify:local:CHEMOTEX:Schrade+Knives:Schrade+Knives:353")}`, second,
  ]);
  assert.deepEqual(theirs.tracks.map((song) => song.name), ["Dumbest Girl Alive", "Schrade Knives", "Residual Stress"]);
  // A local file counts in the playlist, as the Spotify app counts it.
  assert.equal(theirs.tracks[1].unavailable, true);
  assert.equal(theirs.tracks[1].duration, 353000);
  assert.equal(theirs.tracks[0].duration, 200000);
  assert.equal(theirs.tracks[0].url, `https://open.spotify.com/track/${first}`);
  // A gid comes back as bytes: the app's album ID is the base62 of them.
  assert.equal(theirs.tracks[0].album.id, "0296TIIbB3u904riPYGPJJ");
  assert.equal(theirs.tracks[0].artists[0].id, "7KUVjxDTSChB9IHu38yRSo");
  assert.equal(theirs.tracks[0].album.imageUrl, "https://i.scdn.co/image/deadbeefdeadbeefdeadbeef");
  assert.equal(theirs.tracks[0].album.name, "10,000 gecs");

  // The player's own token reads spclient; the app's Web API token doesn't.
  const reads = calls.filter((call) => call.url.host === "spclient.wg.spotify.com");
  // The rows, then one metadata request for the two songs that need details.
  assert.equal(reads.length, 2);
  assert.equal(reads[0].headers.Authorization, "Bearer player-access");
  // Two songs cost one metadata request, not one each.
  const metadata = reads.filter((call) => call.url.pathname === "/extended-metadata/v0/extended-metadata");
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].method, "POST");
  assert.equal(metadata[0].headers["Content-Type"], "application/x-protobuf");
});

test("a listener who never approves the player identity keeps the note", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, items: { total: 30 } });
  }, {
    saved: signedIn(),
    // A closed page is a rejected approval, and nothing else is asked for.
    redirect: async () => { throw new Error("sign-in timed out"); },
  });
  const theirs = await plugin.playlist({ id: "theirs" });
  assert.deepEqual(theirs.tracks, []);
  assert.match(theirs.description, /only your own and collaborative playlists/);
  // The second playlist doesn't open a browser window again.
  const again = await plugin.playlist({ id: "theirs" });
  assert.deepEqual(again.tracks, []);
});

test("a chart country reads the artist's popular songs over the session", async () => {
  const popular = "0qMZXgcLfkl5RI3q50KHMH";
  // The same ID as the 16 bytes an artist's chart is made of.
  const POPULAR_GID = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const searched = [];
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") { searched.push(call); return json({ tracks: { items: [], next: null } }); }
    if (path === "/metadata/4/artist/e04de8ad658745069acb1691368654cf") {
      return bytes(pbJoin([
        pbString(2, "Artist"), pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
        pbBytes(4, pbJoin([
          pbString(1, "US"), pbBytes(2, pbJoin([pbBytes(1, POPULAR_GID)]))])),
        pbBytes(4, pbJoin([
          pbString(1, "JP"), pbBytes(2, pbJoin([pbBytes(1, POPULAR_GID)]))])),
      ]));
    }
    if (path === "/extended-metadata/v0/extended-metadata") {
      return bytes(metadataAnswer([entity(`spotify:track:${popular}`, pbJoin([
        pbString(2, "Popular Song"),
        pbBytes(3, pbJoin([pbString(2, "Album")])),
        pbBytes(4, pbJoin([pbString(2, "Artist")])),
        pbSint(7, 120000),
      ]))]));
    }
    throw new Error(`unexpected ${path}`);
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "jp" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((song) => song.id), [popular]);
  // The country in the setting chose the list, and no search was made.
  assert.deepEqual(searched, []);
  const artist = calls.find((call) => call.url.pathname.startsWith("/metadata/4/artist/"));
  assert.equal(artist.url.searchParams.get("country"), "JP");
  assert.equal(artist.headers.Authorization, "Bearer player-access");
});

test("with no chart country set, an artist page reads the US chart", async () => {
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [], next: null } });
    if (path.startsWith("/metadata/4/artist/")) return bytes(pbJoin([pbString(2, "Artist")]));
    throw new Error(`unexpected ${path}`);
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "" } });
  await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  const artist = calls.find((call) => call.url.pathname.startsWith("/metadata/4/artist/"));
  assert.equal(artist.url.searchParams.get("country"), "US");
});

// Spotify can revoke the player approval. The artist page then asks for a
// new one, instead of falling back to search on every page from then on.
test("a revoked player approval is asked for again by the artist page", async () => {
  const popular = "0qMZXgcLfkl5RI3q50KHMH";
  const POPULAR_GID = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  // An access token past its time, and a refresh token Spotify revoked.
  const store = new Map([["player", {
    accessToken: "old-access", refreshToken: "revoked", expiresAt: Date.now() - 1000,
  }]]);
  const prompts = [];
  const { plugin, calls, opened } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/api/token") {
      const form = new URLSearchParams(call.body);
      if (form.get("grant_type") === "refresh_token") {
        return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
      }
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    if (path === "/v1/me") return json(me);
    if (path.startsWith("/playlist/v2/user/")) return bytes(new Uint8Array());
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/metadata/4/artist/e04de8ad658745069acb1691368654cf") {
      return bytes(pbJoin([pbString(2, "Artist"),
        pbBytes(4, pbJoin([pbString(1, "JP"), pbBytes(2, pbJoin([pbBytes(1, POPULAR_GID)]))]))]));
    }
    if (path === "/extended-metadata/v0/extended-metadata") {
      return bytes(metadataAnswer([entity(`spotify:track:${popular}`, pbJoin([pbString(2, "Popular Song"), pbSint(7, 1000)]))]));
    }
    throw new Error(`unexpected ${path}`);
  }, {
    saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" },
    // The plugin listens before it opens the browser: answer once it has.
    redirect: async (_options, urls) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { code: "code", state: new URL(urls.at(-1)).searchParams.get("state") };
    },
  });
  globalThis.host.signInPrompt = (prompt) => prompts.push(prompt.text);

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((song) => song.id), [popular]);
  // One browser window, saying what it is for.
  assert.equal(opened.length, 1);
  assert.match(prompts[0], /popular songs on an artist's page/);
  assert.equal(store.get("player").refreshToken, "new-refresh");
  const artist = calls.find((call) => call.url.pathname.startsWith("/metadata/4/artist/"));
  assert.equal(artist.headers.Authorization, "Bearer new-access");
});

test("an artist page turned down for the approval falls back to search once", async () => {
  let asked = 0;
  const { plugin, opened } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/artists/ar1/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    throw new Error(`unexpected ${path}`);
  }, {
    saved: signedIn(), settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" },
    redirect: async () => { asked++; throw new Error("sign-in timed out"); },
  });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["s1"]);
  // The next artist page doesn't open a browser window again.
  await plugin.artist({ id: "ar1" });
  assert.equal(asked, 1);
  assert.equal(opened.length, 1);
});

test("an artist page comes from the session when the quota is spent", async () => {
  const song = "0qMZXgcLfkl5RI3q50KHMH";
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const ALBUM = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const kindOf = (body) => {
    const bytes = Array.from(body || []);
    const at = bytes.findIndex((byte, index) => byte === 0x08 && (bytes[index + 1] === 9 || bytes[index + 1] === 10));
    return at < 0 ? 0 : bytes[at + 1];
  };
  const { plugin } = await setup((call) => {
    if (call.url.host === "api.spotify.com") {
      return json({ error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } }, 429);
    }
    if (call.url.pathname === "/metadata/4/artist/e04de8ad658745069acb1691368654cf") {
      return bytes(pbJoin([
        pbString(2, "Artist"),
        pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
        pbBytes(5, pbBytes(1, pbJoin([pbBytes(1, ALBUM)]))),
        pbBytes(4, pbJoin([pbString(1, "JP"), pbBytes(2, pbJoin([pbBytes(1, POPULAR)]))])),
      ]));
    }
    if (kindOf(call.body) === 9) {
      return bytes(metadataAnswer([entity(`spotify:album:${base62Of(ALBUM)}`, pbJoin([
        pbString(2, "Album"),
        pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
      ]))]));
    }
    return bytes(metadataAnswer([entity(`spotify:track:${song}`, pbJoin([
      pbString(2, "Popular Song"),
      pbBytes(4, pbJoin([pbString(2, "Artist")])),
      pbSint(7, 120000),
    ]))]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.equal(page.artist.name, "Artist");
  assert.match(page.artist.imageUrl, /^https:\/\/i\.scdn\.co\/image\//);
  assert.deepEqual(page.tracks.map((t) => t.name), ["Popular Song"]);
  assert.deepEqual(page.albums.map((a) => a.name), ["Album"]);
});

test("with a country set, the charts win even while the Web API answers", async () => {
  const song = "0qMZXgcLfkl5RI3q50KHMH";
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const searched = [];
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") { searched.push(call); return json({ tracks: { items: [], next: null } }); }
    if (path === "/metadata/4/artist/e04de8ad658745069acb1691368654cf") {
      return bytes(pbJoin([
        pbString(2, "Artist"),
        pbBytes(4, pbJoin([pbString(1, "JP"), pbBytes(2, pbJoin([pbBytes(1, POPULAR)]))])),
      ]));
    }
    return bytes(metadataAnswer([entity(`spotify:track:${song}`, pbJoin([
      pbString(2, "Chart Song"), pbSint(7, 100000),
    ]))]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((t) => t.name), ["Chart Song"]);
  assert.deepEqual(searched, []);
  // The Web API still answered the albums, so the session didn't fetch them.
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
});

const quota = { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } };
// Spotify says how long a spent quota lasts: here, 35077 s, about 10 h.
const spent = () => json(quota, 429, { "retry-after": "35077" });

test("a spent quota is named, with how long it lasts", async () => {
  let calls = 0;
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/me") return json(me);
    if (path === "/v1/playlists/p1") {
      return json({ id: "p1", name: "L", owner: { id: "listener" },
        items: { total: 2, items: [{ item: track("a") }], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" } });
    }
    calls++;
    return spent();
  }, { saved: signedIn() });

  // The playlist still loads, with the reason in its description.
  const list = await plugin.playlist({ id: "p1" });
  assert.equal(list.tracks.length, 1);
  assert.match(list.description, /quota for your app is spent\. Part of this page is missing\. It comes back in about 10 h\./);
  // A quota hours away isn't waited out.
  assert.equal(calls, 1);
});

test("an artist page the quota emptied says so in a grey row", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/me/library/contains") return json([false]);
    return spent();
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "ar1" });
  assert.equal(page.artist.name, "Artist");
  assert.deepEqual(page.albums, []);
  assert.equal(page.tracks.length, 1);
  const [row] = page.tracks;
  assert.equal(row.unavailable, true);
  assert.match(row.id, /^missing:/);
  assert.match(row.name, /quota for your app is spent/);
  assert.match(row.artists[0].name, /about 10 h/);
  // The row can't be played or saved.
  await assert.rejects(plugin.remotePlay({ ids: [row.id] }), /can't play this song/);
});

test("an artist page names the quota when only its albums are missing", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    return spent();
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["missing:quota", "s1"]);
});

test("an artist page the quota didn't touch has no note", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/artists/ar1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    // Another page spent its quota earlier: this one is unaffected.
    return spent();
  }, { saved: signedIn() });
  await plugin.browse({ page: "top" });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["s1"]);
});

test("the pages that can say the quota is spent, say so", async () => {
  const { plugin } = await setup(() => spent(), { saved: signedIn() });
  // Home is headed by the app itself, which shows no description of ours, so
  // the note lives on the pages the plugin makes: here, Top tracks.
  const top = await plugin.browse({ page: "top" });
  assert.match(top.description, /quota for your app is spent/);
  assert.equal(top.sections.length, 3);
  const recent = await plugin.browse({ page: "recent" });
  assert.match(recent.description, /about 10 h/);
  // Home says it in each section the quota emptied.
  const home = await plugin.home();
  for (const section of home.sections) assert.match(section.empty, /quota for your app is spent/);
});

test("a page Spotify answered says nothing of a quota spent elsewhere", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1/albums") return spent();
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path.startsWith("/v1/me/top/")) return json({ items: [] });
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  await plugin.artist({ id: "ar1" });
  const top = await plugin.browse({ page: "top" });
  assert.equal(top.description, undefined);
});
