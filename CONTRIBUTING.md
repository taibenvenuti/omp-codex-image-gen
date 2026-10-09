# Contributing

> Modified by Oh My Pi contributors from pi-codex-image-gen (Apache-2.0).

## Development

```sh
npm install
npm test
npm run check
npm run pack:dry-run
```

Link the checkout for local OMP testing:

```sh
omp plugin link /path/to/omp-codex-image-gen
```

Run `/login codex-images` (or log in to **ChatGPT Plus/Pro (Codex)**), complete the ChatGPT browser login, and ask OMP to generate an image. Live generation consumes image quota; unit tests do not make external requests. Neither the Codex app nor OMP's `openai-codex` OAuth helpers are required for `codex-images`.

### Image delivery smoke test

The default tests use synthetic credentials and mocked SSE; they do not consume subscription quota.

For an explicitly authorized live smoke test, load this package in a disposable OMP profile with the existing image-capable OAuth login. Keep credentials out of the repository and do not copy them into test fixtures. Generate one image using `codex_generate_image_artifact` with `save: "none"` and inspect the original pixels at `result.artifact.path`. Run `/image-artifacts`, reload, and recover the same file without regeneration. Do not retry an ambiguous connection/quota failure. Do not use the separately billed API CLI.

Validate the optional Python fallback without an API key:

```sh
python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --model gpt-image-2.5-flare --quality max --dry-run
python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --background transparent --output-format png --dry-run
python3 skills/imagegen/scripts/remove_chroma_key.py --help
```

`npm test` requires Python 3 on PATH. CLI regression tests use only its standard library and make dry-run requests. Extension tests mock the backend; neither test path consumes image quota.

The vendored CLI changes for Images 2.5 cover documented quality and flexible size settings plus GPT Image 2 transparency preview. They do not change API endpoints, authentication, or defaults.

Do not modify the vendored Python helper without documenting why.

Optional live smoke test (requires explicit approval to use image quota): load this checkout with `omp plugin link`, generate one PNG, and edit it using `referencedImagePaths`. Verify inline display and saved bytes. Confirm that progress and the final summary do not invent an image model, and that `backendImageModel` is `"unknown"` unless the backend explicitly reports one. Verify `reportedImage` size/quality/background against the response, then inspect actual pixels for dimensions and alpha. A successful image does not prove which backend model ran. Never include credentials or raw image payloads in test reports.

For auth compatibility, run the smoke test with `/login codex-images` while chat uses another provider. Verify the provider appears in `/login`, not `/model`, and that OMP persists the image credential under its own ID. Check `details.provider: "codex-images"` and `details.transport: "codex-responses"`. If OMP `openai-codex` is available, test it separately without owned image credentials; it should report `openai-codex` / `codex-responses`. With both logins, owned image OAuth wins. A selected auth failure must not switch accounts. With only chat OAuth or an API key, the tool must ask for `/login codex-images` before any image request.

Test `/logout codex-images` without changing the chat login. On a remote/headless machine, test the full-redirect-URL fallback and callback-port conflicts. Never paste a callback into chat. Automated tests exercise provider registration, PKCE/state, loopback/manual callbacks, cancellation, concurrent refresh, and image tool wiring using mocked token/image responses. They do not prove that a fresh live browser grant or a particular account supports the image endpoint.

On October 2, 2026, the upstream maintainer reported that the package-owned flow worked in a live smoke test. This is a user-confirmed result, not automated verification of every account or of the served image model.

On October 2, 2026, upstream live diagnostics with new `openai` plan-sharing OAuth rejected Responses image tools with `subscription_sharing_unsupported_capability`, and direct Images calls with `hardened_oauth_rule_missing`. OpenAI's [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) list image generation as unsupported. The same chat grant could call a local image function; separate image-capable Codex OAuth produced verified PNGs through both native Images and Codex Responses endpoints. These probes established the grant distinction, not a live test of this package-owned browser login.

## Subscription capability check

Checked on September 11, 2026, with a ChatGPT subscription token and no API-key billing. These observations are account- and date-specific, not a public API guarantee.

- Installed Codex `0.153.4` and upstream commit `4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042` both use the standalone images client for image generation. Its model is hard-coded to `gpt-image-2`; background, size, and quality are automatic.
- The request path is determined by subscription authentication: `https://chatgpt.com/backend-api/codex/images/generations` (or `images/edits`).
- A bounded diagnostic using the direct route generated an image. The existing Responses route also generated an image. All six returned PNG files passed Pillow verification and decoding.
- Requests naming Flare and Sunburst succeeded, but a deliberately invalid model name also succeeded. None reported a served model. Do not interpret HTTP 200 as proof of selectable models.
- An explicit `1536x1024`, `high`, `transparent` direct request returned `1254x1254`, `low`, `opaque`. Pixel inspection confirmed RGB output without transparency. Do not add guaranteed controls based on the request schema alone.
- GET diagnostics with the original Python client header returned a Cloudflare challenge. A package-specific User-Agent reached method validation in the Python diagnostic. Cookie-free Node GET requests with the shipping headers reached the Responses route (405), but the direct route still returned a Cloudflare challenge (403). A User-Agent is not a universal challenge fix.
- The successful live generation probes used a Codex-compatible diagnostic User-Agent, a model-list warmup, and an in-memory allowlisted infrastructure-cookie jar. These were compatibility probes, not a live run of the extension. The shipping extension keeps an honest package User-Agent and does not copy that cookie/warmup flow.
- Model selection through the Responses tool, native transparency by prompting, and live editing were not established by this six-request check. Keep them separate from the proven baseline generation result.

Source references:

- [Installed Codex image tool](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/image-generation/src/tool.rs)
- [Subscription base URL selection](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/model-provider-info/src/lib.rs)
- [Images endpoint client](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/codex-api/src/endpoint/images.rs)
- [Codex client headers](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/login/src/auth/default_client.rs)

Future probes should use a known-working control, one changed setting at a time, an invalid-model control for selection claims, and decoded output checks. Obtain a generation budget first, bound time/response sizes, disable automatic retries, and record only sanitized metadata. Do not repeat an ambiguous failed generation automatically.

## Pull request checklist

- Keep extension logic in `extensions/index.ts` and `src/` unless there is a clear reason to split.
- When changing tool parameters, update the `ToolParams` interface, the schema built with OMP's injected `omp.arktype`, and the tool description/prompt text — OMP surfaces the schema and description to the model. Keep runtime imports dependency-free so Git marketplace installs load without `npm install`.
- Treat save-mode names, config file keys, and auth flow as public interface; changes to defaults or precedence are breaking changes.
- Do not modify `skills/imagegen/scripts/image_gen.py` without a documented reason; it is a vendored fallback.
- The Codex Responses SSE contract is private and may change. If generation breaks, inspect sanitized event types, status codes, and allowlisted output metadata. Never log raw response bodies or auth headers.
- Keep the OMP tool subscription-only: prefer package-owned `codex-images` OAuth, preserve available `openai-codex` support, and never use the `openai` chat token, Codex app credentials, or `OPENAI_API_KEY` for tool requests.
- Keep tool parameters, tests, README documentation, and changelog entries synchronized.

## Tracking upstream

Upstream is [`jvm/pi-mono`](https://github.com/jvm/pi-mono), directory
`packages/pi-codex-image-gen`. The local `upstream-imagegen` branch contains
that directory's history extracted to the repository root with `git subtree split`.
Keep it unmodified; OMP changes belong on `master`.

The ancestry bridge uses monorepo commit
`99678b11a2636102fc111c0ea6f97ee66abfdec8` (package-only commit
`ed8fb6ca772672539f74dd71c8909199ac67a94a`) as a **selected baseline**:
the latest package snapshot before the August 26, 2026 import. The exact
original source revision is unknown. Thirteen imported files match this
snapshot byte-for-byte; the bridge records the existing OMP port as the
downstream result without changing its implementation or rewriting old commits.
Later upstream changes were not included in the bridge.

The first normal upstream merge, of `upstream-imagegen` commit
`033515f5a62f21fe5a45bae7274e56576901c242` (`pi-codex-image-gen` 0.1.15),
integrated the later upstream changes while keeping the OMP implementation
details listed in the checklist above.

On a fresh clone, configure the remote once:

```sh
git remote add -t main upstream https://github.com/jvm/pi-mono.git
```

From this repository, refresh the package-only branch:

```sh
git fetch --no-tags upstream
upstream_checkout=$(mktemp -d)
git worktree add --detach "$upstream_checkout" upstream/main
git -C "$upstream_checkout" subtree split \
  --prefix=packages/pi-codex-image-gen upstream/main -b upstream-imagegen
git worktree remove "$upstream_checkout"
```

Use the same split options on every refresh; changing annotations or squashing
would change the ancestry. If extraction fails, stop before merging and inspect
the error. Do not force-update a diverged `upstream-imagegen` branch.

With a clean working tree on `master`, review and merge:

```sh
git log --oneline HEAD..upstream-imagegen
git diff HEAD...upstream-imagegen
git merge --no-ff --no-commit upstream-imagegen
```

Resolve conflicts while retaining OMP integration, configuration paths, and
package identity. Run the development checks and local OMP smoke test above,
then complete the update with `git commit`. Normal merges preserve tracking of what was
integrated; do not use the bridge's `ours` strategy for future updates.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
