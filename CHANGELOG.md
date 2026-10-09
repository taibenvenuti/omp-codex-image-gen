# Changelog

## [Unreleased]

### Documentation

- Summarize independent image credentials, absent-only legacy fallback, routing-model semantics, and separately invoked API billing.

### Added

- Add `codex_generate_image_artifact` for scripted and nested workflows, returning structured original-file metadata instead of base64 image payloads.
- Add branch-local artifact recovery, recent-artifact edits, and `/image-artifacts`; keep completed private temporary originals through script failures and reload.

### Fixed

- Preserve recoverable artifacts when persistent saves fail and report post-generation storage failures without retries.
- Anchor recovery before generation so cancelled commits that finish after tree navigation or session replacement remain recoverable only from the originating branch and its forks.

### Changed

- Connect package-only upstream history at a documented selected baseline and add the upstream update procedure, preserving the OMP implementation and existing commits.
- Sync with upstream `pi-codex-image-gen` 0.1.15 (`033515f`), including unreleased artifact work, keeping the OMP package identity, `@oh-my-pi` APIs, `~/.omp` configuration, and package version. Upstream's Pi-specific version baseline and install telemetry are not imported.
- Use `gpt-6-astra` as the default Codex image-routing model instead of `gpt-5.5`. Preserve explicit tool/configuration overrides and backend-selected image rendering.

### Imported upstream release history (`pi-codex-image-gen` 0.1.13–0.1.15)

These entries describe upstream releases brought in by the sync above; they are not OMP releases.

#### Added

- Add package-owned ChatGPT image OAuth through `/login codex-images`, with OMP-managed credential storage and refresh. Keep chat on any provider without installing Codex.
- Report backend image metadata, generation stages, byte counts, and elapsed time without guessing the served image model.
- Support Flare and Sunburst Images 2.5 API model IDs and their September 8 snapshots with `xhigh` and `max` CLI quality settings. Keep existing defaults.
- Validate documented flexible dimensions for both 2.5 models and the GPT Image 2 dated snapshot in CLI generation, editing, and batch workflows.

#### Changed

- Describe the Codex image model as backend-selected. Report its ID only if the backend supplies one; otherwise return `backendImageModel: "unknown"`.

#### Fixed

- Keep image authentication separate from the unsupported `openai` plan-sharing image route. Preserve available OMP `openai-codex` credentials as a fallback when package-owned image credentials are absent.
- Keep OAuth refresh errors private and avoid switching accounts after a selected OAuth failure.
- Keep manual-login guidance visible when the local callback port is occupied.
- Identify subscription requests with a package User-Agent and distinguish Cloudflare challenges from account/model failures.
- Bound network time, streamed/error output, prompts, and input images; handle fragmented CRLF streams and incomplete results; avoid quota-error retries and accidental file overwrites.
- Allow GPT Image 2 native transparency preview with PNG/WebP in the API CLI, and remove outdated older-model fallback requirements from skill guidance.

## [0.1.0] - 2026-08-26

### Added

- Port `pi-codex-image-gen` to Oh My Pi's plugin manifest and extension APIs.
- Generate and edit images through OMP's existing `openai-codex` login.
- Support up to five local or recent conversation images.
- Save validated PNG, JPEG, or WebP output globally, per project, or to a custom directory.
- Bundle the imagegen skill and optional Python CLI fallback.
