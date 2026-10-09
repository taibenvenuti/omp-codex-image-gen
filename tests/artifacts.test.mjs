import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import imageExtension from "../.test-dist/extensions/index.js";
import { ARTIFACT_ENTRY, RESERVATION_ENTRY, artifactRecord, readArtifactManifest, reserveArtifact } from "../.test-dist/src/artifacts.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
const SYSTEM_TMP = tmpdir();
const RESERVATION_PREFIX = "omp-codex-image-";

function jwt() {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url");
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.signature`;
}

function eventsResponse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function imageResponse(bytes = PNG) {
  return eventsResponse([
    { type: "response.output_item.done", item: {
      type: "image_generation_call", id: "image-fixture", status: "completed", result: bytes.toString("base64"),
    } },
    { type: "response.completed", response: { id: "response-fixture", usage: { total_tokens: 1 } } },
  ]);
}

// Drives the real extension registration against an in-memory session branch;
// only the Codex network boundary is stubbed.
async function fixture(t) {
  const root = await mkdtemp(join(SYSTEM_TMP, "image-artifact-test-"));
  const previous = Object.fromEntries(["TMPDIR", "PI_CODING_AGENT_DIR", "OMP_CODEX_IMAGE_SAVE_MODE", "OMP_CODEX_IMAGE_SAVE_DIR"].map(key => [key, process.env[key]]));
  process.env.TMPDIR = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.OMP_CODEX_IMAGE_SAVE_MODE;
  delete process.env.OMP_CODEX_IMAGE_SAVE_DIR;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const state = { branch: [], handler: () => imageResponse(), sessionId: "session-1", calls: 0 };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return state.handler(body, init);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const tools = {};
  const commands = {};
  const sent = [];
  imageExtension({
    registerProvider() {},
    registerTool(tool) { tools[tool.name] = tool; },
    registerCommand(name, command) { commands[name] = command; },
    appendEntry(customType, data) {
      state.branch.push({ type: "custom", customType, data, id: `entry-${state.branch.length + 1}` });
    },
    sendMessage(message) { sent.push(message); },
  });
  const ctx = {
    cwd: root,
    isProjectTrusted: () => false,
    modelRegistry: {
      find: () => undefined,
      authStorage: {
        listOAuthAccounts: provider => provider === "openai-codex" ? [{}] : [],
        getOAuthAccess: async () => ({ accessToken: jwt() }),
      },
    },
    sessionManager: {
      getSessionId: () => state.sessionId,
      getBranch: () => state.branch,
      getLeafId: () => state.branch.at(-1)?.id ?? null,
    },
  };
  return {
    root, requests, state, sent, ctx,
    artifacts: () => state.branch.filter(entry => entry.customType === ARTIFACT_ENTRY),
    reservations: () => state.branch.filter(entry => entry.customType === RESERVATION_ENTRY),
    leftovers: async () => (await readdir(root)).filter(name => name.startsWith(RESERVATION_PREFIX)),
    run: (name, params = {}, signal) =>
      tools[name].execute(`call-${++state.calls}`, { prompt: "fixture", save: "none", ...params }, signal, undefined, ctx),
  };
}

for (const [format, bytes, suffix] of [["png", PNG, "png"], ["jpeg", JPEG, "jpg"], ["webp", WEBP, "webp"]]) {
  test(`artifact tool returns ${format} metadata and a private original, never image bytes`, async t => {
    const h = await fixture(t);
    h.state.handler = () => imageResponse(bytes);
    const result = await h.run("codex_generate_image_artifact", { outputFormat: format });
    assert.ok(!result.content.some(block => block.type === "image"), format);
    const { artifact } = result.details;
    assert.ok(artifact.path.endsWith(`.${suffix}`));
    assert.equal(artifact.byteCount, bytes.length);
    assert.deepEqual(await readFile(artifact.path), bytes);
    assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
    assert.deepEqual(h.state.branch.map(entry => entry.customType), [RESERVATION_ENTRY, ARTIFACT_ENTRY]);
    assert.equal(h.artifacts()[0].data.artifact.path, artifact.path);
  });
}

test("inline tool returns the image and records no artifact", async t => {
  const h = await fixture(t);
  const result = await h.run("codex_generate_image");
  assert.equal(result.content.find(block => block.type === "image")?.data, PNG.toString("base64"));
  assert.equal(result.details.artifact, undefined);
  assert.deepEqual(h.state.branch, []);
});

for (const save of ["project", "global", "custom"]) {
  test(`artifact and ${save} persistent copy coexist`, async t => {
    const h = await fixture(t);
    const first = await h.run("codex_generate_image_artifact", { save, saveDir: "out" });
    assert.notEqual(first.details.artifact.path, first.details.savedPath);
    assert.deepEqual(await readFile(first.details.artifact.path), PNG);
    assert.deepEqual(await readFile(first.details.savedPath), PNG);
    assert.equal(first.details.saveWarning, undefined);
    // The backend image ID repeats, so the exclusive persistent write must not overwrite.
    const repeated = await h.run("codex_generate_image_artifact", { save, saveDir: "out" });
    assert.equal(repeated.details.savedPath, undefined);
    assert.match(repeated.details.saveWarning, /could not be saved/);
    assert.deepEqual(await readFile(first.details.savedPath), PNG);
    assert.deepEqual(await readFile(repeated.details.artifact.path), PNG);
  });
}

test("failed persistent save still delivers a recoverable original", async t => {
  const h = await fixture(t);
  await writeFile(join(h.root, "blocked"), "not a directory");
  const result = await h.run("codex_generate_image_artifact", { save: "custom", saveDir: "blocked" });
  assert.equal(result.details.savedPath, undefined);
  assert.ok(result.details.saveWarning.length < 1000);
  assert.deepEqual(await readFile(result.details.artifact.path), PNG);
  assert.equal(h.requests.length, 1);
});

test("unavailable artifact storage rejects before any image request", async t => {
  const h = await fixture(t);
  process.env.TMPDIR = join(h.root, "missing-root");
  await assert.rejects(h.run("codex_generate_image_artifact"), /No generation request was made/);
  assert.equal(h.requests.length, 0);
});

test("artifacts feed chained path edits and recent-image edits", async t => {
  const h = await fixture(t);
  const first = await h.run("codex_generate_image_artifact");
  await h.run("codex_generate_image_artifact", { prompt: "edit", referencedImagePaths: [first.details.artifact.path] });
  await h.run("codex_generate_image_artifact", { prompt: "recent edit", numLastImagesToInclude: 1 });
  assert.equal(h.requests.length, 3);
  for (const request of h.requests.slice(1)) {
    assert.equal(request.input[0].content[1].image_url, `data:image/png;base64,${PNG.toString("base64")}`);
  }
  assert.equal(h.artifacts().length, 3);
});

test("/image-artifacts lists and recent edits recover originals by branch", async t => {
  const h = await fixture(t);
  const before = h.state.branch.slice();
  const first = await h.run("codex_generate_image_artifact");
  const completed = h.state.branch.slice();
  // A second extension instance has no memory of the first run: recovery comes from the branch alone.
  const fresh = [];
  imageExtension({
    registerProvider() {}, registerTool() {}, appendEntry() {}, sendMessage: message => fresh.push(message),
    registerCommand: (name, command) => { if (name === "image-artifacts") fresh.command = command; },
  });
  await fresh.command.handler("", h.ctx);
  assert.match(fresh[0].content, new RegExp(first.details.artifact.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  h.state.branch = before;
  await fresh.command.handler("", h.ctx);
  assert.match(fresh[1].content, /No image artifacts recorded/);
  await assert.rejects(h.run("codex_generate_image_artifact", { numLastImagesToInclude: 1 }), /only 0 were available/);
  h.state.branch = completed.slice();
  await h.run("codex_generate_image_artifact", { numLastImagesToInclude: 1 });
  assert.equal(h.requests.length, 2);
  await unlink(first.details.artifact.path);
  h.state.branch = completed.slice();
  await assert.rejects(h.run("codex_generate_image_artifact", { numLastImagesToInclude: 1 }));
  assert.equal(h.requests.length, 2);
});

test("a reservation whose result was never attached recovers from its manifest", async t => {
  const h = await fixture(t);
  const pending = await reserveArtifact("png");
  const artifact = await pending.commit(PNG, "image/png");
  await pending.publish({ artifact, toolCallId: "interrupted" });
  await pending.dispose();
  h.state.branch = [{
    type: "custom", customType: RESERVATION_ENTRY, id: "entry-1",
    data: { path: pending.path, mimeType: "image/png", toolCallId: "interrupted" },
  }];
  await h.run("codex_generate_image_artifact", { numLastImagesToInclude: 1 });
  assert.equal(h.requests[0].input[0].content[1].image_url, `data:image/png;base64,${PNG.toString("base64")}`);
});

for (const failure of ["quota", "connection", "incomplete"]) {
  test(`artifact ${failure} failures never retry or retain empty reservations`, async t => {
    const h = await fixture(t);
    h.state.handler = () => {
      if (failure === "connection") throw new Error("PRIVATE_NETWORK_DETAIL");
      if (failure === "quota") return Response.json({ error: { code: "usage_limit_reached", message: "PRIVATE_BODY" } }, { status: 429 });
      return eventsResponse([{ type: "response.incomplete" }]);
    };
    await assert.rejects(h.run("codex_generate_image_artifact"), error => !/PRIVATE/.test(error.message));
    assert.equal(h.requests.length, 1);
    assert.deepEqual(await h.leftovers(), []);
    assert.equal(h.artifacts().length, 0);
  });
}

test("cancelling a stalled artifact stream cleans its reservation but keeps the recovery anchor", async t => {
  const h = await fixture(t);
  let cancelled = false;
  h.state.handler = () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  const controller = new AbortController();
  const running = h.run("codex_generate_image_artifact", {}, controller.signal);
  while (h.requests.length === 0) await delay(5);
  controller.abort();
  await assert.rejects(running);
  assert.equal(cancelled, true);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await h.leftovers(), []);
  assert.equal(h.reservations().length, 1);
});

test("private reservations clean only incomplete files; metadata rejects unsafe records", async t => {
  const root = await mkdtemp(join(SYSTEM_TMP, "image-reservation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = await reserveArtifact("png", root);
  await pending.dispose();
  assert.equal((await readdir(root)).length, 0);
  const completed = await reserveArtifact("png", root);
  const artifact = await completed.commit(PNG, "image/png");
  await completed.dispose();
  assert.deepEqual(await readFile(artifact.path), PNG);
  assert.equal(artifactRecord({ artifact, toolCallId: "fixture" }).artifact.path, artifact.path);
  for (const changes of [{ path: "../escape" }, { mimeType: "text/html" }, { byteCount: 33 * 1024 * 1024 }, { path: "/tmp/\nunsafe" }]) {
    assert.equal(artifactRecord({ artifact: { ...artifact, ...changes }, toolCallId: "fixture" }), undefined);
  }
  await assert.rejects(reserveArtifact("../escape", root), /Unsupported/);
  await assert.rejects(reserveArtifact("png", "/tmp/\nunsafe"), /unsupported/);
});

test("recovery manifests are bounded, validated, private, and reject symlinks", async t => {
  const root = await mkdtemp(join(SYSTEM_TMP, "artifact-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = await reserveArtifact("png", root);
  const reservation = { path: pending.path, mimeType: "image/png", toolCallId: "fixture" };
  assert.equal(await readArtifactManifest(reservation), undefined);
  const artifact = await pending.commit(PNG, "image/png");
  await pending.publish({ artifact, toolCallId: "fixture" });
  await pending.dispose();
  assert.equal((await stat(`${pending.path}.json`)).mode & 0o777, 0o600);
  assert.equal((await readArtifactManifest(reservation)).artifact.path, artifact.path);
  assert.equal(await readArtifactManifest({ ...reservation, toolCallId: "other-call" }), undefined);
  const target = join(root, "manifest-target.json");
  await writeFile(target, await readFile(`${pending.path}.json`));
  await unlink(`${pending.path}.json`);
  await symlink(target, `${pending.path}.json`);
  assert.equal(await readArtifactManifest(reservation), undefined);
  await unlink(`${pending.path}.json`);
  await writeFile(`${pending.path}.json`, "x".repeat(8193));
  assert.equal(await readArtifactManifest(reservation), undefined);
  await writeFile(`${pending.path}.json`, JSON.stringify({ artifact: { ...artifact, mimeType: "text/html" }, toolCallId: "fixture" }));
  assert.equal(await readArtifactManifest(reservation), undefined);
});
