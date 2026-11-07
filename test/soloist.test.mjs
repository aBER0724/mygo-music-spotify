import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT, json, empty, signedIn, setup, me, playing, fakeSoloist, fastPolling, noDeviceThenSoloist,
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
  assert.equal(args[args.indexOf("--data-dir") + 1], "/data/spotify/soloist");
  assert.equal(storage.get("device"), "local");
  assert.deepEqual(removed, ["librespot"]);
  plugin.signOut();
  assert.equal(player.killed, true);
  assert.deepEqual(removed, ["librespot", "soloist"]);
});

test("the first time, Soloist is downloaded from Spotify and unpacked with tar", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ installed: false });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(player.spawns.map((s) => s.command), ["soloist/soloist", "curl", "tar", "soloist/soloist"]);
  assert.equal(player.spawns[1].args.at(-1), "https://soloist-builds.spotifycdn.com/soloist_release_osx_arm64.tar.gz");
  assert.deepEqual(player.spawns[2].args, ["-xf", "soloist/soloist_release_osx_arm64.tar.gz", "-C", "soloist"]);
});

test("an expired build is downloaded again", async (t) => {
  fastPolling(t);
  const player = fakeSoloist({ expireOnce: true });
  const { handler } = noDeviceThenSoloist(player);
  const { plugin } = await setup(handler, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(player.spawns.map((s) => s.command), ["soloist/soloist", "curl", "tar", "soloist/soloist"]);
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
  assert.equal(curl[curl.indexOf("--retry") + 1], "2");
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
