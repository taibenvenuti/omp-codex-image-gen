import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { type } from "@oh-my-pi/omptype";
import extension from "../.test-dist/extensions/index.js";
import { extractImageAccountId, IMAGE_AUTH_PROVIDER, imageAuthProvider, parseImageOAuthCallback } from "../.test-dist/src/image-oauth.js";

const REDIRECT = "http://localhost:1455/auth/callback";
const CODE = "test-only-authorization-code";
const REFRESH = "test-only-refresh-token";
const { oauth } = imageAuthProvider;

function jwt(accountId = "test-account") {
  const data = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${data}.signature`;
}

function callback(authorize, code = CODE) {
  const url = new URL(REDIRECT);
  url.searchParams.set("state", authorize.searchParams.get("state"));
  url.searchParams.set("code", code);
  return url.href;
}

function mockTokenFetch(t, responder = () => Response.json({ access_token: jwt(), refresh_token: REFRESH, expires_in: 3600 })) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://auth.openai.com/oauth/token");
    requests.push(init);
    return responder(init);
  };
  return { requests, original };
}

function interaction(prompt) {
  const events = [];
  const controller = new AbortController();
  let authorize;
  return {
    controller, events,
    get authorize() { return authorize; },
    value: {
      signal: controller.signal,
      onAuth(info) {
        events.push({ type: "auth_url", ...info });
        authorize = new URL(info.url);
      },
      onProgress: message => events.push({ type: "info", message }),
      onPrompt: params => prompt(authorize, params, controller),
    },
  };
}

function pendingPrompt(_authorize, _params, controller) {
  return new Promise((_, reject) => {
    if (controller.signal.aborted) reject(new Error("test-only-cancel"));
    else controller.signal.addEventListener("abort", () => reject(new Error("test-only-cancel")), { once: true });
  });
}

test("extension registers an auth-only OAuth provider with OMP's provider API", async t => {
  const h = mockTokenFetch(t);
  const registered = [];
  extension({
    arktype: type,
    registerProvider: (name, config) => registered.push({ name, config }),
    registerTool() {},
    registerCommand() {},
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, IMAGE_AUTH_PROVIDER);
  assert.equal(registered[0].config.models, undefined);
  const ui = interaction(async authorize => callback(authorize));
  const saved = await registered[0].config.oauth.login(ui.value);
  assert.equal(saved.access, jwt());
  assert.equal(saved.refresh, REFRESH);
  assert.equal(saved.accountId, "test-account");
  assert.equal(registered[0].config.oauth.getApiKey(saved), jwt());
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.redirect, "error");
  assert.equal(request.body.get("grant_type"), "authorization_code");
  assert.equal(request.body.get("code"), CODE);
  assert.equal(request.body.get("redirect_uri"), REDIRECT);
  assert.equal(request.body.get("client_id"), ui.authorize.searchParams.get("client_id"));
  assert.equal(createHash("sha256").update(request.body.get("code_verifier")).digest("base64url"),
    ui.authorize.searchParams.get("code_challenge"));
  assert.equal(ui.authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(ui.authorize.searchParams.get("state").length >= 43);
});

test("loopback callback rejects wrong state, accepts a valid callback, and closes the port", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    const invalid = new URL(callback(authorize));
    invalid.hostname = "127.0.0.1";
    invalid.searchParams.set("state", "wrong-state");
    const rejected = await h.original(invalid);
    assert.equal(rejected.status, 400);
    const text = await rejected.text();
    assert.ok(!text.includes(CODE) && !text.includes("wrong-state"));
    const valid = new URL(callback(authorize));
    valid.hostname = "127.0.0.1";
    const accepted = await h.original(valid);
    assert.equal(accepted.status, 200);
    await accepted.text();
    return pendingPrompt(authorize, params, ui.controller);
  });
  const saved = await oauth.login(ui.value);
  assert.equal(saved.access, jwt());
  assert.equal(h.requests.length, 1);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("occupied callback port falls back to a state-checked full redirect URL", async t => {
  const server = createServer((_request, response) => response.end("test-only-listener"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(1455, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    assert.match(params.message, /local callback port is unavailable/);
    assert.match(params.message, /full redirect URL/);
    return callback(authorize);
  });
  await oauth.login(ui.value);
  assert.ok(ui.events.some(event => event.type === "info" && /port/.test(event.message)));
  const auth = ui.events.find(event => event.type === "auth_url");
  assert.match(auth.instructions, /local callback port is unavailable/);
  assert.match(auth.instructions, /full redirect URL/);
});

test("callback validation rejects stale, duplicate, denied, oversized, and untrusted inputs", () => {
  const valid = `${REDIRECT}?state=expected&code=${CODE}`;
  assert.equal(parseImageOAuthCallback(valid, "expected"), CODE);
  for (const url of [
    CODE, valid.replace("localhost", "evil.example"), valid.replace("/auth/callback", "/other"),
    valid.replace("state=expected", "state=stale"), `${valid}&state=expected`, `${valid}&code=another`,
    `${valid}&error=access_denied`, `${REDIRECT}?state=expected`, `${valid}${"x".repeat(8192)}`,
    valid.replace("localhost", "userinfo@localhost"), `${valid}#fragment`,
  ]) assert.throws(() => parseImageOAuthCallback(url, "expected"), error =>
    /Invalid image OAuth callback|authorization was denied/.test(error.message) && !error.message.includes(CODE));
});

test("denied loopback authorization ends login without exposing backend error details", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    const url = new URL(callback(authorize));
    url.hostname = "127.0.0.1";
    url.searchParams.delete("code");
    url.searchParams.set("error", "test-only-private-error");
    url.searchParams.set("error_description", REFRESH);
    const response = await h.original(url);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes(REFRESH));
    return pendingPrompt(authorize, params, ui.controller);
  });
  await assert.rejects(oauth.login(ui.value), error =>
    /authorization was denied/.test(error.message) && !error.message.includes(REFRESH));
  assert.equal(h.requests.length, 0);
});

test("manual callback errors never reach token exchange", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async () => `${REDIRECT}?state=stale&code=${CODE}`);
  await assert.rejects(oauth.login(ui.value), /Invalid image OAuth callback/);
  assert.equal(h.requests.length, 0);
});

test("login cancellation stops promptly and closes its callback listener", async t => {
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params, controller) => {
    controller.abort();
    return pendingPrompt(authorize, params, ui.controller);
  });
  await assert.rejects(oauth.login(ui.value), /cancelled/);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("refresh returns the rotated image credential", async t => {
  const h = mockTokenFetch(t);
  const rotated = await oauth.refreshToken({ access: jwt(), refresh: "old-test-refresh", expires: 0 });
  assert.equal(oauth.getApiKey(rotated), jwt());
  assert.equal(rotated.refresh, REFRESH);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.get("grant_type"), "refresh_token");
  assert.equal(h.requests[0].body.get("refresh_token"), "old-test-refresh");
});

test("OAuth failures are sanitized", async t => {
  for (const response of [
    () => new Response(`PRIVATE_BODY_${REFRESH}`, { status: 400 }),
    () => Response.json({ access_token: jwt(), refresh_token: REFRESH }),
    () => Response.json({ access_token: "not-an-image-token", refresh_token: REFRESH, expires_in: 3600 }),
    () => Response.json({ access_token: jwt(), refresh_token: REFRESH, expires_in: -1 }),
    () => { throw new Error(`PRIVATE_FETCH_${REFRESH}`); },
  ]) await t.test("rejected token response", async t => {
    mockTokenFetch(t, response);
    await assert.rejects(oauth.refreshToken({ access: jwt(), refresh: REFRESH, expires: 0 }), error =>
      /login codex-images/.test(error.message) && !error.message.includes(REFRESH) && !error.message.includes("PRIVATE"));
  });
});

test("token response bounds do not expose credentials", async t => {
  let cancelled = false;
  mockTokenFetch(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(65537)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(oauth.refreshToken({ access: jwt(), refresh: REFRESH, expires: 0 }), /exchange failed/);
  assert.equal(cancelled, true);
});

test("token request deadline aborts a stalled exchange", async t => {
  const timeout = AbortSignal.timeout;
  const deadline = new AbortController();
  t.after(() => { AbortSignal.timeout = timeout; });
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 30000);
    return deadline.signal;
  };
  const h = mockTokenFetch(t, () => new Promise(() => {}));
  const request = oauth.refreshToken({ access: jwt(), refresh: REFRESH, expires: 0 });
  deadline.abort();
  await assert.rejects(request, /exchange failed/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].signal.aborted, true);
});

test("login deadline closes the callback and never exchanges a code", async t => {
  const timeout = AbortSignal.timeout;
  const deadline = new AbortController();
  t.after(() => { AbortSignal.timeout = timeout; });
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 600000);
    return deadline.signal;
  };
  const h = mockTokenFetch(t);
  const ui = interaction(async (authorize, params) => {
    deadline.abort();
    return pendingPrompt(authorize, params, ui.controller);
  });
  await assert.rejects(oauth.login(ui.value), /timed out/);
  assert.equal(h.requests.length, 0);
  assert.equal(ui.controller.signal.aborted, false);
  await assert.rejects(h.original("http://127.0.0.1:1455/auth/callback"));
});

test("account routing claim cannot inject headers and does not authenticate a JWT locally", () => {
  assert.equal(extractImageAccountId(jwt()), "test-account");
  for (const value of [jwt("bad\r\nInjected: value"), jwt("test-account\n"), jwt("test-account\r"),
    jwt("test-account\u2028"), `${jwt()}\n`, jwt(""), jwt(null), "not-a-jwt",
    `header.${Buffer.from("null").toString("base64url")}.signature`]) {
    assert.throws(() => extractImageAccountId(value), error =>
      /valid ChatGPT account ID/.test(error.message) && !error.message.includes(value));
  }
});
