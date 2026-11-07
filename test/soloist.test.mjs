import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT, json, empty, signedIn, setup, me, track, playing, fakeSoloist, fastPolling, noDeviceThenSoloist,
} from "./helpers.mjs";

test("with no Spotify app open, Soloist starts, plays, and is remembered", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin, storage, removed } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, [null, "soloist-id"]);
  const { command, args } = player.spawns.at(-1);
  assert.equal(command, "soloist/soloist");
  assert.equal(args[args.indexOf("--device-name") + 1], "MyGo Music on Mac");
  assert.equal(args[args.indexOf("--api-key") + 1], "synthetic-soloist-key");
  assert.equal(args[args.indexOf("--data-dir") + 1], "/data/spotify-connect/soloist");
  assert.equal(storage.get("device"), "local");
  assert.deepEqual(removed, ["librespot"]);
  plugin.signOut();
  assert.equal(player.killed, true);
  assert.deepEqual(removed, ["librespot", "soloist", "soloist-cache"]);
  // The built-in player chosen here isn't chosen for the next account.
  assert.equal(storage.get("device"), undefined);
});

test("the first time, Soloist is downloaded, unpacked and checked before it runs", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin, removed } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(player.spawns.map((s) => s.command),
    ["soloist/soloist", "tar", "curl", "tar", "soloist/soloist", "soloist/soloist"]);
  const curl = player.spawns[2].args;
  // The archive waits in the plugin's data folder, which an update keeps.
  assert.equal(curl[curl.indexOf("--output") + 1], "/data/spotify-connect/soloist-download/soloist_release_osx_arm64.tar.gz");
  assert.equal(curl.at(-1), "https://soloist-builds.spotifycdn.com/soloist_release_osx_arm64.tar.gz");
  assert.deepEqual(player.spawns[3].args,
    ["-xf", "/data/spotify-connect/soloist-download/soloist_release_osx_arm64.tar.gz", "-C", "soloist"]);
  // It runs the unpacked binary once to check it, before starting it.
  assert.deepEqual(player.spawns[4].args, ["--version"]);
  // A download that worked is kept for the next update to install from.
  assert.ok(!removed.includes("soloist-download"));
});

test("an expired build is downloaded again and checked", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ expireOnce: true });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(player.spawns.map((s) => s.command),
    ["soloist/soloist", "curl", "tar", "soloist/soloist", "soloist/soloist"]);
  assert.deepEqual(player.spawns[3].args, ["--version"]);
});

// Pairing takes longer than the app gives a command: ask to pair and play
// again, and keep Soloist running meanwhile.
test("an unpaired Soloist asks to be picked in a Spotify app, then plays", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ paired: false });
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /choose "MyGo Music on Mac"/);
  assert.equal(player.killed, false);
  player.paired = true;
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(plays.at(-1), "soloist-id");
  assert.equal(player.spawns.length, 1);
});

test("a remembered built-in player starts again before the play command", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const plays = [];
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices([{ id: "ghost", name: "HOMEPC", is_active: true }]) });
    if (call.url.pathname === "/v1/me/player/play") { plays.push(call.url.searchParams.get("device_id")); return empty(); }
    return playing("a");
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  storage.set("device", "local");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, ["soloist-id"]);
});

test("the built-in player says what it needs", async (t) => {
  fastPolling(t);
  const noDevice = (call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: [] });
    return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
  };
  // No Soloist key: off to the plugin's settings.
  let ctx = await setup(noDevice, { saved: signedIn(), settings: { clientId: CLIENT }, spawn: () => assert.fail("spawned") });
  await assert.rejects(ctx.plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "setup", message: /Soloist API key/ });
  // Not allowed to start programs: the same.
  ctx = await setup(noDevice, { saved: signedIn(), spawn: () => { throw new Error("the listener hasn't allowed this plugin to start programs"); } });
  await assert.rejects(ctx.plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "setup", message: /allow this plugin to start programs/ });
  // It stopped: what it last said is the reason.
  const player = fakeSoloist({ exitWith: "error: invalid api key" });
  ctx = await setup(noDevice, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(ctx.plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "unavailable", message: /invalid api key/ });
});

test("the device menu offers the built-in player, and choosing it transfers playback there", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const transfers = [];
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices([{ id: "phone", name: "Phone", is_active: true }]) });
    transfers.push(JSON.parse(call.body).device_ids);
    return empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  const menu = await plugin.remoteDevices();
  assert.deepEqual(menu.map((d) => d.id), ["phone", "local"]);
  await plugin.remoteUse({ deviceId: "local" });
  assert.deepEqual(transfers, [["soloist-id"]]);
  assert.equal(storage.get("device"), "local");
  assert.deepEqual((await plugin.remoteDevices()).map((d) => d.id), ["phone", "soloist-id"]);
});

test("saving a Soloist key starts Soloist at once, ready to pair", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ paired: false });
  const settings = { clientId: CLIENT, soloistKey: "" };
  const { plugin } = await setup((call) => json({ devices: player.devices() }), { saved: signedIn(), settings, spawn: (...args) => player.spawn(...args) });
  settings.soloistKey = "synthetic-soloist-key";
  plugin.setSetting({ key: "soloistKey", value: settings.soloistKey });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(player.spawns.at(-1).command, "soloist/soloist");
  // Clearing the key stops it.
  settings.soloistKey = "";
  plugin.setSetting({ key: "soloistKey", value: "" });
  assert.equal(player.killed, true);
});

test("Soloist that ended after it was ready starts again", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin, storage } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  storage.set("device", "local");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.length, 1);
  player.crash();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.length, 2);
  assert.equal(plays.at(-1), "soloist-id");
});

test("a passing error while waiting for Soloist doesn't stop it", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  let failures = 2;
  const base = noDeviceThenSoloist(player);
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices" && player.current && failures > 0) { failures--; throw new Error("offline"); }
    return base.handler(call);
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remoteUse({ deviceId: "local" });
  assert.equal(player.killed, false);
  assert.equal(player.spawns.length, 1);
});

test("the device menu offers Soloist only with a key", async () => {
  const { plugin } = await setup(() => json({ devices: [] }), { saved: signedIn(), settings: { clientId: CLIENT } });
  assert.deepEqual(await plugin.remoteDevices(), []);
});

test("Soloist's download has a time limit and retries", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  const curl = player.spawns.find((s) => s.command === "curl").args;
  assert.equal(curl[curl.indexOf("--max-time") + 1], "300");
  assert.equal(curl[curl.indexOf("--connect-timeout") + 1], "20");
  assert.equal(curl[curl.indexOf("--retry") + 1], "3");
  assert.equal(curl[curl.indexOf("--retry-max-time") + 1], "120");
  assert.ok(curl.includes("--retry-all-errors"));
  // Only Spotify's address, only over https, also after a redirect.
  assert.equal(curl[curl.indexOf("--proto") + 1], "=https");
  assert.equal(curl[curl.indexOf("--proto-redir") + 1], "=https");
  assert.ok(curl.includes("--fail"));
});

// Seen in a host test: another computer's Soloist of the same name, on the
// same account, was taken for this one.
test("another Soloist of the same name isn't taken for this one", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ paired: false });
  const twin = [{ id: "other-mac", name: "MyGo Music on Mac", is_active: true }];
  const { handler, plays } = noDeviceThenSoloist(player, twin);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remoteUse({ deviceId: "local" }), /choose "MyGo Music on Mac"/);
  assert.ok(!plays.includes("other-mac"));
  assert.ok((await plugin.remoteDevices()).some((d) => d.id === "local"));
  // Signing out ends the wait for pairing, which would otherwise go on.
  plugin.signOut();
});

// The plugin's folder is replaced by an update, which takes the binary with
// it. The downloaded archive is in the plugin's data folder, which stays.
test("after an update, Soloist is installed from the archive kept, not downloaded again", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false, staged: true });
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(player.spawns.map((s) => s.command),
    ["soloist/soloist", "tar", "soloist/soloist", "soloist/soloist"]);
  assert.deepEqual(player.spawns[2].args, ["--version"]);
  assert.ok(!player.spawns.some((s) => s.command === "curl"));
  assert.equal(plays.at(-1), "soloist-id");
});

test("a kept archive whose build is nearly expired is downloaded again", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false, staged: true, buildAge: 100 * 24 * 60 * 60 * 1000 });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.filter((s) => s.command === "curl").length, 1);
  // Checked once as it came from the kept archive, once as it was downloaded.
  assert.equal(player.spawns.filter((s) => s.command === "soloist/soloist" && s.args[0] === "--version").length, 2);
});

test("a download that can't be unpacked is reported, and asked for again after a moment", async (t) => {
  fastPolling(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const player = fakeSoloist({ installed: false, tarFails: true });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin, removed } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /Couldn't unpack Spotify Soloist/);
  const downloads = () => player.spawns.filter((s) => s.command === "curl").length;
  assert.equal(downloads(), 1);
  // Half downloaded isn't kept for an install to trust later.
  assert.ok(removed.includes("soloist-download"));
  player.staged = false;
  // The app moves on to the next song at once; don't ask Spotify again yet.
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /Couldn't unpack Spotify Soloist/);
  assert.equal(downloads(), 1);
  now += 20000;
  player.tarFails = false;
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(downloads(), 2);
});

test("a downloaded player that can't run isn't started", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false, versionFails: true });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /can't run/);
  // The last thing asked of it was whether it runs: it was never started.
  assert.deepEqual(player.spawns.at(-1).args, ["--version"]);
});

test("a build still expired after a download says so, rather than starting it", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ expireOnce: true, cdnStale: true, buildAge: 100 * 24 * 60 * 60 * 1000 });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /build has expired/);
});

test("an expired build is renewed even when it says so with another exit code", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ expireOnce: true, expireText: true });
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.ok(player.spawns.some((s) => s.command === "curl"));
  assert.equal(plays.at(-1), "soloist-id");
});

// A Soloist left running by MyGo Music that crashed holds its data folder.
test("a Soloist left running by an earlier session is named", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ exitWith: 'Error: another session is running for data directory "/data/spotify-connect/soloist".' });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }),
    /still running from an earlier MyGo Music session/);
});

test("Soloist is found by name when it never says its device ID", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ paired: false, announceId: false });
  const transfers = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices() });
    if (call.url.pathname === "/v1/me/player") { transfers.push(JSON.parse(call.body).device_ids); return empty(); }
    return empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remoteUse({ deviceId: "local" }), /choose "MyGo Music on Mac"/);
  player.paired = true;
  await plugin.remoteUse({ deviceId: "local" });
  assert.deepEqual(transfers.at(-1), ["soloist-id"]);
});

test("a remembered built-in player with no key doesn't stop another device playing", async (t) => {
  fastPolling(t);
  const plays = [];
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: [{ id: "mac", name: "Mac", is_active: true }] });
    if (call.url.pathname === "/v1/me/player/play") { plays.push(call.url.searchParams.get("device_id")); return empty(); }
    return playing("a");
  }, { saved: signedIn(), settings: { clientId: CLIENT } });
  storage.set("device", "local");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, [null]);
  assert.equal(storage.get("device"), undefined);
});

test("choosing a device clears the hold a failed play left", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  let playWorks = false;
  const plays = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices() });
    if (call.url.pathname === "/v1/me/player/play") { plays.push(call.url.searchParams.get("device_id")); return empty(); }
    if (call.url.pathname === "/v1/me/player") return playWorks ? playing("a") : empty();
    return empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /didn't start playing/);
  playWorks = true;
  await plugin.remoteUse({ deviceId: "local" });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(plays.at(-1), "soloist-id");
});

// A device Spotify still lists as active may be offline and answer 204 while
// something else plays: that must not pass as the device having started.
test("a silent device isn't hidden by another device already playing", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const plays = [];
  let onSoloist = false;
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") {
      return json({ devices: player.devices([
        { id: "ghost", name: "HOMEPC", is_active: true },
        { id: "phone", name: "Phone", is_active: false },
      ]) });
    }
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      if (device === "soloist-id") onSoloist = true;
      return empty();
    }
    return onSoloist
      ? json({ is_playing: true, item: track("a"), device: { id: "soloist-id", name: "MyGo Music on Mac" } })
      : json({ is_playing: true, item: track("elsewhere"), device: { id: "phone", name: "Phone" } });
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  storage.set("device", "ghost");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  // The ghost never started it: the built-in player is tried, and plays.
  assert.deepEqual(plays, ["ghost", "soloist-id"]);
  assert.equal(storage.get("device"), "local");
});

test("the built-in player starts again when its device leaves Spotify", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const plays = [];
  let lost = false;
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") {
      // Its device is gone while the process still runs, until it starts over.
      if (lost && player.spawns.length >= 2) lost = false;
      return json({ devices: lost ? [] : player.devices() });
    }
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      if (lost) return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
      return empty();
    }
    return lost ? empty() : playing("a");
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  storage.set("device", "local");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.length, 1);
  lost = true;
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.length, 2);
  assert.equal(plays.at(-1), "soloist-id");
});

test("a Soloist that was still shutting down is started again", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ lockOnce: true });
  const { handler, plays } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.equal(player.spawns.length, 2);
  assert.equal(plays.at(-1), "soloist-id");
});

test("what an older Soloist wrote doesn't outlive it", async (t) => {
  fastPolling(t);
  // The build expired and was replaced, and the new one then failed for a
  // reason of its own: it must be that reason that's told.
  const player = fakeSoloist({ expireOnce: true, thenExitWith: "error: invalid api key" });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /invalid api key/);
});

test("a play that never got going doesn't leave the built-in player chosen", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const { plugin, storage } = await setup((call) => {
    // Only once it runs does it show: the device is started, then refused.
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices() });
    if (call.url.pathname === "/v1/me/player/play") return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
    return empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /Open Spotify on your computer or phone/);
  assert.equal(storage.get("device"), undefined);
});

test("a download that fails says why, and isn't left half kept", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false, curlFails: true });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin, removed } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /Couldn't download Spotify Soloist.*timed out/s);
  assert.ok(removed.includes("soloist-download"));
});

test("Windows gets the Windows build and the .exe", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false, binary: "soloist/soloist.exe" });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, {
    saved: signedIn(), platform: "windows", arch: "amd64", spawn: (...args) => player.spawn(...args),
  });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  const curl = player.spawns.find((s) => s.command === "curl").args;
  assert.equal(curl.at(-1), "https://soloist-builds.spotifycdn.com/soloist_release_windows_x86_64.zip");
  assert.deepEqual(player.spawns.at(-1).args.slice(0, 2), ["--device-name", "MyGo Music on Windows"]);
});

test("Linux gets its own build", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, {
    saved: signedIn(), platform: "linux", arch: "arm64", spawn: (...args) => player.spawn(...args),
  });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  const curl = player.spawns.find((s) => s.command === "curl").args;
  assert.equal(curl.at(-1), "https://soloist-builds.spotifycdn.com/soloist_release_arm64.tar.gz");
  assert.deepEqual(player.spawns.at(-1).args.slice(0, 2), ["--device-name", "MyGo Music"]);
});

test("an Intel Mac isn't offered Soloist at all", async (t) => {
  fastPolling(t);
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: [] });
    return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
  }, { saved: signedIn(), platform: "darwin", arch: "amd64" });
  assert.deepEqual(await plugin.remoteDevices(), []);
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), /isn't made for this computer/);
});
