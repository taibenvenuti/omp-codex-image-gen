# omp-codex-image-gen

Generate and edit images inside [Oh My Pi](https://github.com/can1357/oh-my-pi) through **ChatGPT subscription image generation**. No Codex app or separate API key is required.

## Features

- **Generate images in conversation** — PNG, JPEG, and WebP.
- **Edit from references** — transform up to five local or recent conversation images.
- **Save where work happens** — return images inline and optionally save them by project, session, or custom directory.
- **Reuse or add an image login** — use OMP's `openai-codex` login, or the package-owned `codex-images` OAuth login that keeps OMP chat on any provider.
- **Recoverable scripted workflows** — generate originals without image payloads, then recover their paths after failures or reloads.
- **Bundled `imagegen` skill** — prompting and transparent-background workflows.

## Install

```sh
omp plugin install omp-codex-image-gen
```

For local development:

```sh
omp plugin link /path/to/omp-codex-image-gen
```

To uninstall:

```sh
omp plugin uninstall omp-codex-image-gen
```

## Usage

Log in once if needed:

```text
/login
```

Select **ChatGPT Plus/Pro (Codex)**, or run `/login codex-images` (see [Authentication](#authentication)). Then ask OMP to create an image:

```text
Generate a pixel-art sword icon with a blue blade and gold hilt.
```

OMP invokes `codex_generate_image` with your prompt, optionally includes up to five local or recent conversation images for editing, streams the response from the Codex backend, and saves the resulting image according to the save mode. The `model` parameter controls the Codex routing model (default `gpt-6-astra`), not the image model. The backend selects the image model; `backendImageModel` is `"unknown"` unless the response explicitly reports an image model.

The tool reports generation stages and the backend's returned size, quality, background, and format in `details.reportedImage`. These are server-reported values, not guarantees inferred from the prompt. `details.byteCount` records decoded bytes; `details.generationDurationMs` records elapsed generation/save time. Check the actual image before using it, especially for exact dimensions or alpha transparency.

### Subscription reliability and limits

- Requests identify this package with its own User-Agent. The `codex-images` login uses the Codex-compatible public OAuth client; it does not launch the Codex app, read its credentials, import browser cookies, or fall back to paid API calls.
- One five-minute network deadline covers the connection, retries, and stream. Escape cancels network work; the remote generation may still finish.
- Prompts: 32,000 characters. References: five regular PNG/JPEG/WebP files or conversation images, at most 20 MiB each and 50 MiB combined.
- Responses: 100 MiB total, with at most one 32 MiB decoded output image. Base64 and format signatures are checked; this is not a full image decoder. Backend text and revised prompts are limited to 4,000 characters; HTTP error bodies are read only up to 16 KiB and are not displayed.
- Transient HTTP failures have bounded retries. Quota exhaustion, moderation errors, failed/incomplete streams, connection errors, and deadlines are not automatically retried. Avoid immediately repeating an ambiguous failure: the first generation may have consumed quota.
- Local save settings are checked before generation. Existing files are never overwritten; a persistent save failure still returns the direct inline image or artifact and a bounded warning.
- Cloudflare challenges are reported as connection failures, not as proof that your subscription or image model is unsupported.

### Direct and artifact tools

| Tool | Delivery |
| --- | --- |
| `codex_generate_image` | Summary and inline image, plus an optional persistent save. |
| `codex_generate_image_artifact` | Structured metadata and an original file path; no image payload. Intended for scripted or nested workflows. |

Both tools use the same generation/editing parameters, image login, backend, validation, and quota safeguards. The artifact tool returns `summary`, `artifact: { path, mimeType, byteCount }`, and optionally `savedPath` and `saveWarning`.

For chained edits, use `referencedImagePaths: [artifact.path]`. `numLastImagesToInclude` also reads artifact records from the current session branch, including generations that were never displayed. The normal 20 MiB per-reference and 50 MiB aggregate limits still apply: a 32 MiB output is recoverable but cannot be used as an edit input without first reducing its size. Each edit is a new generation request and can consume quota.

#### Artifact storage and recovery

The artifact tool reserves a new private `omp-codex-image-*` directory under the OS temporary directory before generating. Original files have user-only permissions (directory `0700`, file `0600`) and are never overwritten. `save: "none"` means **no persistent user copy** for this tool; it does not disable temporary original storage. The direct tool's `none` mode still does not write the image to disk.

Completed originals are not automatically deleted by this extension, including on script failure/timeout, reload, shutdown, or branch changes. They remain until user or OS temporary-file cleanup; there is no guaranteed retention period across OS cleanup or reboot. Copy needed assets to persistent storage. Only incomplete reservations owned by the current call are cleaned up.

Before generation, a branch-local `codex-image-artifact-reservation` entry anchors recovery to the originating branch. On completion, a private, bounded JSON manifest beside the reserved original records path, MIME type, byte count, and call ID. Normal same-branch completions also append a `codex-image-artifact` session entry, without image bytes or prompts. Late completions after cancellation do not append records to unrelated branches or replacement sessions; the original branch's reservation reads the manifest. Run `/image-artifacts` to list the last 20 recorded original paths on the current branch without generation or network work. Records survive reload, resume, and session forks that preserve the entries; abandoned branches are not included. Listing reads validated recovery manifests, not image bytes, and does not verify that an original still exists. A missing original fails recent-image editing before generation; do not regenerate it automatically.

If temporary storage is known to be unavailable, the artifact call fails before generation. If writing the original fails after generation, a successful requested persistent save becomes the recovery artifact, with a warning. If neither file can be saved, the call fails explicitly: **quota may already have been consumed and there is no recoverable artifact**. No generation retry is made. A failure to persist session recovery metadata is reported with the recoverable file path rather than hiding the completed file.

### Images 2.5 and API fallback

The optional `skills/imagegen/scripts/image_gen.py` API CLI accepts `--model gpt-image-2.5-flare` or `--model gpt-image-2.5-sunburst`, including their `2026-09-08` snapshots. Both accept `--quality xhigh` and `--quality max` in addition to the existing quality settings. The CLI default remains `gpt-image-2`. Both 2.5 models support `--size auto` and custom dimensions such as `1536x864`, under the [documented size constraints](skills/imagegen/references/image-api.md#flexible-sizes-gpt-image-2-and-25). Resolutions above `2560x1440` are experimental.

GPT Image 2 now supports native transparency in preview: use `--model gpt-image-2 --background transparent --output-format png` (or `webp`) in confirmed CLI mode. This uses `OPENAI_API_KEY` and separate API billing. The OMP tool still uses chroma-key removal because it has no background parameter.

Public API model selection does not establish support for the same options on the private Codex backend. The extension does not expose Flare/Sunburst selection or claim that your account has received the Images 2.5 rollout.

In subscription tests on September 11, 2026, the direct endpoint accepted Flare, Sunburst, and an invalid model name without reporting a served model. It also returned different size, quality, and background values than requested. The Responses route generated an image successfully. These account-specific results do not justify a guaranteed subscription model selector. See [the investigation and test procedure](CONTRIBUTING.md#subscription-capability-check).

## Authentication

| Credential / route | Model selection | Usage and fallback |
| --- | --- | --- |
| `codex-images` OAuth / private Codex Responses | `model` selects a routing model, not an image model | ChatGPT image quota; preferred credential |
| OMP `openai-codex` OAuth / same backend | Same routing semantics | Used only when owned image credentials are absent; no switch after an auth/generation failure |
| `openai` ChatGPT plan-sharing login | Any chat model | Not accepted for image generation; never sent to this backend |
| OpenAI API key | Explicit standalone Python CLI only | Separate API billing; never an automatic fallback from the OMP tool |

Changing the chat default does not change image authentication or certify the image backend's served model. The backend chooses the image model; successful inference on another route is not image capability evidence.

The extension owns an image-capable ChatGPT OAuth flow, registered as **Codex Images** (`codex-images`). OMP stores its credentials and handles refresh. Your chat provider can remain unchanged; image authentication is independent.

```text
/login codex-images
```

Complete the browser login with your ChatGPT account. You can also run `/login` and select **Codex Images (ChatGPT subscription)**. The browser redirects to `http://localhost:1455/auth/callback`. If the callback cannot reach OMP, paste the **full redirect URL** into OMP's login prompt, not into chat. Login expires after ten minutes.

OMP stores the `codex-images` credential in its own credential store. `/logout codex-images` removes that credential without changing your chat login. No credential files are created by the extension itself.

The package implements the Codex-compatible OAuth protocol itself. It neither imports OMP's `openai-codex` OAuth helpers nor requires the Codex app or its credential store. It still depends on OpenAI continuing to accept that public OAuth client and private image endpoint; this is not a new OAuth application registered with OpenAI.

Existing OMP `openai-codex` credentials (**ChatGPT Plus/Pro (Codex)** in `/login`) remain a compatibility fallback when `codex-images` credentials are absent. With both image logins, `codex-images` wins. A selected login that fails to refresh or generate does not switch to another account.

Both image logins use `https://chatgpt.com/backend-api/codex/responses`. The `openai` plan-sharing OAuth grant is different and [does not support image generation](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The extension never sends that chat token to the Codex backend. API keys do **not** enable this tool or API-key billing.

## Configuration

| Scope | Path |
| --- | --- |
| Global | `~/.omp/agent/extensions/codex-image-gen.json` |
| Project | `<project-root>/.omp/extensions/codex-image-gen.json` |

Project configuration overrides global configuration for trusted projects.

```json
{
  "save": "global",
  "saveDir": "~/Pictures/generated",
  "model": "gpt-6-astra"
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `save` | string | `"global"` | `none`, `project`, `global`, or `custom` |
| `saveDir` | string | — | Directory used by `custom` mode |
| `model` | string | `"gpt-6-astra"` | Codex routing model, not the backend image model |

Environment overrides:

- `OMP_CODEX_IMAGE_SAVE_MODE`
- `OMP_CODEX_IMAGE_SAVE_DIR`

## Save modes

| Mode | Behavior |
| --- | --- |
| `none` | Direct tool: inline image, no disk save. Artifact tool: private temporary original, no persistent copy. |
| `project` | Saves to `<project>/.omp/generated-images/<session-id>/`. |
| `global` | Saves to `<omp-agent-dir>/generated-images/<session-id>/`. |
| `custom` | Saves to `<saveDir>/<session-id>/` (requires `saveDir` or env). `~` and `~/...` expand to the current user's home directory. |

## Tool parameters

Both generation entry points accept these parameters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | ✅ | The image generation prompt. |
| `model` | string | — | Override the Codex routing model. Defaults to config or `gpt-6-astra`. |
| `outputFormat` | string | — | `png` (default), `jpeg`, or `webp`. |
| `save` | string | — | Override save mode for this call. |
| `saveDir` | string | — | Directory when `save=custom`. Relative paths resolve under CWD. |
| `referencedImagePaths` | string[] | — | Up to five local images to edit. Relative paths resolve under CWD. |
| `numLastImagesToInclude` | integer | — | Include the most recent one to five conversation images for editing. Mutually exclusive with `referencedImagePaths`. |

## How it works

1. Resolves package-owned `codex-images` OAuth via OMP, or falls back to available `openai-codex` OAuth.
2. Sends a request to the Codex Responses endpoint and routing model (default `gpt-6-astra`) with the `image_generation` tool enabled.
3. For edits, attaches the selected local or conversation images to the request.
4. The backend selects an image model to generate or edit the image.
5. Parses the SSE stream and strictly validates the returned base64 and image format.
6. For the artifact tool, commits the reserved temporary original and records its branch-local recovery metadata.
7. Saves a persistent copy according to the active save mode; failures produce a bounded warning without discarding a usable inline image or artifact.
8. Returns the direct inline image or structured artifact metadata.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Missing image OAuth credentials" | No image-capable subscription login; chat OAuth and API keys are not sufficient | Run `/login codex-images` or log in to **ChatGPT Plus/Pro (Codex)** |
| 401 / 403 response | Image login rejected or token expired | Re-run `/login codex-images` |
| 429 response | Rate limited | Wait and retry; the extension retries transient failures with backoff, not quota exhaustion |
| "Codex did not return an image" | Backend refused the prompt | Rephrase the prompt and try again |
| "save=custom requires saveDir" | Missing config | Set `saveDir` in config or `OMP_CODEX_IMAGE_SAVE_DIR` |

## Development

```sh
npm install
npm test
npm run check
npm run pack:dry-run
```

The normal tool path uses an image-capable ChatGPT Codex OAuth login. The bundled Python CLI fallback is separate and requires `OPENAI_API_KEY`.

## License and attribution

Apache-2.0. This is an OMP port of [`pi-codex-image-gen`](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-image-gen) by Jose Mocito.

The bundled imagegen skill includes files derived from [OpenAI Codex](https://github.com/openai/codex). See [NOTICE](./NOTICE) and `skills/imagegen/LICENSE.txt`.
