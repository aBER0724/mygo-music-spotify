import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CLIENT, json, signedIn, setup, me,
} from "./helpers.mjs";

// The host holds its storage lock while importing the module.
test("module initialization doesn't touch host storage", async () => {
  const { plugin, reads } = await setup(() => json(me));
  assert.deepEqual(reads, []);
  assert.equal(await plugin.account(), null);
});

test("a missing or malformed Client ID sends the listener to settings", async () => {
  for (const clientId of [undefined, "not-a-client-id"]) {
    const { plugin, calls } = await setup(() => json(me), { settings: { clientId } });
    await assert.rejects(plugin.signIn(), { code: "setup" });
    await assert.rejects(plugin.home(), { code: "setup" });
    assert.equal(calls.length, 0);
  }
});

test("signed-out pages ask to sign in without calling Spotify", async () => {
  const { plugin, calls } = await setup(() => json(me));
  await assert.rejects(plugin.home(), { code: "signIn" });
  await assert.rejects(plugin.liked({ offset: 0 }), { code: "signIn" });
  assert.deepEqual(await plugin.isLiked({ ids: ["a"] }), { a: false });
  assert.equal(calls.length, 0);
});

// The challenge must be SHA-256 of the verifier, as Spotify checks it.
test("PKCE sign-in exchanges the code and keeps only the tokens", async () => {
  for (let round = 0; round < 3; round++) {
    let authorize;
    const { plugin, storage, calls } = await setup((call) => {
      if (call.url.pathname === "/api/token") {
        const form = new URLSearchParams(call.body);
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("code"), "synthetic-code");
        assert.equal(form.get("client_id"), CLIENT);
        assert.equal(form.get("redirect_uri"), "http://127.0.0.1:43821/callback");
        const challenge = createHash("sha256").update(form.get("code_verifier")).digest("base64url");
        assert.equal(challenge, authorize.get("code_challenge"));
        return json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 });
      }
      assert.equal(call.headers.Authorization, "Bearer synthetic-access");
      return json(me);
    }, {
      redirect: async (options, opened) => {
        assert.equal(options.port, 43821);
        assert.equal(options.path, "/callback");
        await Promise.resolve();
        authorize = new URL(opened[0]).searchParams;
        assert.equal(authorize.get("code_challenge_method"), "S256");
        assert.match(authorize.get("scope"), /user-modify-playback-state/);
        return { code: "synthetic-code", state: authorize.get("state") };
      },
    });
    const profile = await plugin.signIn();
    assert.deepEqual([profile.id, profile.name], ["listener", "Listener"]);
    assert.deepEqual(Object.keys(storage.get("session")).sort(), ["accessToken", "clientId", "expiresAt", "refreshToken"]);
    assert.equal(calls.length, 2);
    plugin.signOut();
    assert.equal(storage.has("session"), false);
    assert.equal(await plugin.account(), null);
  }
});

test("sign-in rejects a redirect with another state, and a cancel", async () => {
  for (const answer of [{ code: "x", state: "forged" }, { error: "access_denied" }]) {
    const { plugin, calls, storage } = await setup(() => json(me), {
      redirect: async (_options, opened) => {
        await Promise.resolve();
        const state = new URL(opened[0]).searchParams.get("state");
        return answer.state ? answer : { ...answer, state };
      },
    });
    await assert.rejects(plugin.signIn());
    assert.equal(calls.length, 0);
    assert.equal(storage.has("session"), false);
  }
});

test("an expired token is refreshed once for concurrent requests, keeping a rotated refresh token", async () => {
  let refreshes = 0;
  const { plugin, storage } = await setup(async (call) => {
    if (call.url.pathname === "/api/token") {
      refreshes++;
      assert.equal(new URLSearchParams(call.body).get("refresh_token"), "synthetic-refresh");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ access_token: "synthetic-new", refresh_token: "synthetic-rotated", expires_in: 3600 });
    }
    assert.equal(call.headers.Authorization, "Bearer synthetic-new");
    return json({ items: [], next: null });
  }, { saved: signedIn({ expiresAt: 0 }) });
  await Promise.all([plugin.liked({ offset: 0 }), plugin.savedAlbums({ offset: 0 })]);
  assert.equal(refreshes, 1);
  assert.equal(storage.get("session").refreshToken, "synthetic-rotated");
});

test("a revoked refresh token signs the listener out", async () => {
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/api/token") return json({ error: "invalid_grant" }, 400);
    return json({}, 401);
  }, { saved: signedIn() });
  await assert.rejects(plugin.liked({ offset: 0 }), { code: "signIn" });
  assert.equal(storage.has("session"), false);
});

test("a session from another Client ID is not used", async () => {
  const { plugin, calls, storage } = await setup(() => json(me), { saved: signedIn({ clientId: "f".repeat(32) }) });
  assert.equal(await plugin.account(), null);
  assert.equal(calls.length, 0);
  assert.equal(storage.has("session"), false);
});

test("an account missing from the app's user list is a setup problem", async () => {
  const { plugin } = await setup(() => json({ error: { status: 403, message: "User not registered in the Developer Dashboard" } }, 403), { saved: signedIn() });
  await assert.rejects(plugin.account(), { code: "setup" });
});

test("signing in again while the browser sign-in waits reuses it, not the busy port", async () => {
  let listens = 0;
  let answer;
  const { plugin, opened } = await setup((call) => {
    if (call.url.pathname === "/api/token") return json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    return json(me);
  }, {
    saved: undefined,
    redirect: () => { listens++; return new Promise((resolve) => { answer = resolve; }); },
  });
  const first = plugin.signIn();
  const second = plugin.signIn();
  await Promise.resolve();
  assert.equal(listens, 1);
  assert.equal(opened.length, 2);
  assert.equal(opened[0], opened[1]);
  answer({ code: "c", state: new URL(opened[0]).searchParams.get("state") });
  assert.deepEqual(await first, await second);
});

test("signing in doesn't need TextEncoder", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  Object.defineProperty(globalThis, "TextEncoder", { value: undefined, configurable: true });
  try {
    let authorize;
    const { plugin } = await setup((call) => {
      if (call.url.pathname === "/api/token") {
        const form = new URLSearchParams(call.body);
        const challenge = createHash("sha256").update(form.get("code_verifier")).digest("base64url");
        assert.equal(challenge, authorize.get("code_challenge"));
        return json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      }
      return json(me);
    }, {
      redirect: async (_options, opened) => {
        await Promise.resolve();
        authorize = new URL(opened[0]).searchParams;
        return { code: "c", state: authorize.get("state") };
      },
    });
    assert.deepEqual(await plugin.signIn(), { id: "listener", name: "Listener", imageUrl: "", page: "me" });
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", descriptor);
  }
});

test("signing in works without Web Crypto, as MyGo Music's runtime has none", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    let authorize;
    const { plugin } = await setup((call) => {
      if (call.url.pathname === "/api/token") {
        const form = new URLSearchParams(call.body);
        const challenge = createHash("sha256").update(form.get("code_verifier")).digest("base64url");
        assert.equal(challenge, authorize.get("code_challenge"));
        return json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      }
      return json(me);
    }, {
      redirect: async (_options, opened) => {
        await Promise.resolve();
        authorize = new URL(opened[0]).searchParams;
        return { code: "c", state: authorize.get("state") };
      },
    });
    assert.deepEqual(await plugin.signIn(), { id: "listener", name: "Listener", imageUrl: "", page: "me" });
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
