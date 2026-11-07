// Shared by the tests: a stand-in for MyGo Music's host and for fetch, so
// the plugin runs here without the app, the network or a Spotify account,
// and fakes of what it talks to (Spotify's answers, Soloist, curl and tar,
// the lyrics sources).
import assert from "node:assert/strict";

// Each test imports the plugin anew, for state of its own.
const PLUGIN = new URL("../src/index.js", import.meta.url).href;

export const CLIENT = "0123456789abcdef0123456789abcdef";

let sequence = 0;

export const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

export const empty = (status = 204) => json(undefined, status);

export const signedIn = (extra = {}) => ({
  clientId: CLIENT, accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
  expiresAt: Date.now() + 3600000, ...extra,
});

export async function setup(handler, { saved, settings = { clientId: CLIENT, soloistKey: "synthetic-soloist-key" }, redirect, spawn } = {}) {
  const storage = new Map(saved ? [["session", structuredClone(saved)]] : []);
  const reads = [];
  const calls = [];
  const opened = [];
  const removed = [];
  globalThis.host = {
    storage: {
      get: (k) => { reads.push(k); return structuredClone(storage.get(k)); },
      set: (k, v) => storage.set(k, structuredClone(v)),
      remove: (k) => storage.delete(k),
    },
    setting: (k) => settings[k],
    t: (text) => text,
    openURL: (url) => opened.push(url),
    signInPrompt: () => {},
    waitForRedirect: (options) => redirect(options, opened),
    platform: "darwin", arch: "arm64", dataDir: "/data/spotify",
    removeDataDir: (name) => removed.push(name),
    spawn: (command, args) => {
      if (!spawn) throw new Error(`fork/exec ${command}: no such file or directory`);
      return spawn(command, args);
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    return handler(call);
  };
  const plugin = await import(`${PLUGIN}?test=${++sequence}`);
  return { plugin, storage, reads, calls, opened, removed };
}

export const track = (id, extra = {}) => ({
  id, type: "track", name: `Song ${id}`, uri: `spotify:track:${id}`, duration_ms: 200000,
  artists: [{ id: "artist1", name: "Artist" }],
  album: { id: "album1", name: "Album", images: [{ url: "https://i.scdn.co/640", width: 640 }, { url: "https://i.scdn.co/64", width: 64 }] },
  ...extra,
});

export const me = { id: "listener", display_name: "Listener", images: [] };

export const playing = (id) => json({ is_playing: true, progress_ms: 10, item: track(id), device: { name: "Mac" } });

// A fake Spotify Soloist, and the curl and tar that fetch it. Once running
// and paired, it shows in Spotify's devices, until killed or it exits.
export function program(lines = [], exitCode) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const queue = [...lines];
  if (exitCode !== undefined) setTimeout(() => finish(exitCode), 0);
  return {
    pid: 1, readLine: async () => (queue.length ? queue.shift() : (await done, null)), wait: () => done,
    kill: () => finish(0), errorOutput: () => "", write() {}, closeStdin() {}, done,
  };
}

export function fakeSoloist({ installed = true, paired = true, expireOnce = false, exitWith } = {}) {
  const state = { installed, paired, spawns: [], current: null, killed: false };
  state.spawn = (command, args) => {
    state.spawns.push({ command, args });
    if (command === "curl") return program([], 0);
    if (command === "tar") { state.installed = true; return program([], 0); }
    assert.equal(command, "soloist/soloist");
    if (!state.installed) throw new Error("fork/exec soloist/soloist: no such file or directory");
    if (expireOnce && !state.expired) { state.expired = true; return program(["client expired"], 10); }
    if (exitWith) return program(["2026-11-08 02:19:20.363: soloist 1.3.10", `2026-11-08 02:19:20.364: ${exitWith}`], 1);
    const run = program([`2026-11-08 02:19:20.388: ready, device_name=${args[1]} device_id=soloist-id`,
      ...(state.paired ? [] : [`2026-11-08 02:19:20.389: waiting for login — connect to "${args[1]}" from your Spotify app`])]);
    const kill = run.kill;
    run.kill = () => { state.killed = true; kill(); };
    state.crash = kill;
    state.current = { alive: true };
    const current = state.current;
    run.done.then(() => { current.alive = false; });
    return run;
  };
  state.devices = (others = []) => [...others, ...(state.current?.alive && state.paired ? [{ id: "soloist-id", name: "MyGo Music on Mac", is_active: false }] : [])];
  return state;
}

// Polls run at once; a command's wait for the built-in player is short.
export function fastPolling(t) {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 500 || ms === 1500 ? 0 : ms === 10000 ? 60 : ms, ...args));
}

export const noDeviceThenSoloist = (player, others = []) => {
  let target = null;
  const plays = [];
  const handler = (call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices(others) });
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      if (!player.devices(others).some((d) => d.id === device)) return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
      target = device;
      return empty();
    }
    return target ? playing("a") : empty();
  };
  return { handler, plays };
};

// Lyrics come from LRCLIB and NetEase, matched by name, artist and length.
export function lyricsSources({ lrclibGet, lrclibSearch = [], neteaseSongs = [], neteaseLyric = {}, fail = [] } = {}) {
  const seen = [];
  const handler = (call) => {
    const { host: h, pathname } = call.url;
    seen.push(`${h}${pathname}`);
    if (fail.includes(h)) throw new Error("offline");
    if (pathname === "/v1/tracks/t1") {
      return json({ id: "t1", name: "驚鴻一面", duration_ms: 256470, artists: [{ name: "許嵩" }], album: { name: "不如吃茶去" } });
    }
    if (pathname === "/api/get") return lrclibGet ? json(lrclibGet) : json({ code: 404 }, 404);
    if (pathname === "/api/search") return json(lrclibSearch);
    if (pathname === "/api/cloudsearch/pc") return json({ code: 200, result: { songs: neteaseSongs } });
    if (pathname === "/api/song/lyric") return json({ code: 200, ...neteaseLyric });
    throw new Error(`unexpected ${pathname}`);
  };
  return { handler, seen };
}
