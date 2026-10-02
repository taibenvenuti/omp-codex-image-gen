# Security Policy

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-image-gen`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.

Report privately by contacting the repository maintainer through GitHub. Include:

- a description of the issue;
- steps to reproduce;
- affected versions or commits, if known;
- any suggested mitigation.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure once a fix or mitigation is available.

## Security model

`pi-codex-image-gen` is a Pi package. Pi extensions execute with the same permissions as the local user running Pi. Users should review installed Pi packages and only install packages from sources they trust.

The extension implements image-capable ChatGPT OAuth under the provider ID `codex-images`, using the Codex-compatible public OAuth client ID (not a client secret). Pi stores access/refresh tokens in its agent credential store, normally `~/.pi/agent/auth.json`, and coordinates refresh. This is local credential persistence, not encrypted secret storage; protect the agent directory and do not commit it. The extension does not write its own credential files or access the Codex app's credential store. `/logout codex-images` removes only the image login. Existing legacy Pi `openai-codex` OAuth remains a fallback when package-owned credentials are absent; refresh or request failure does not switch accounts.

Browser login uses random OAuth state and S256 PKCE. Its callback listener binds only to `127.0.0.1:1455`; the registered redirect URI is `http://localhost:1455/auth/callback`. Loopback HTTP is limited to this local callback. Automatic and pasted callbacks must have the expected origin, path, and state. Pasted input must be the full redirect URL, never a bare authorization code. Invalid callbacks cannot finish login. Listener cleanup runs on success, failure, and cancellation. Login has a ten-minute limit; token requests have a 30-second limit and 64 KiB response bound, with no retries or redirects. Do not paste login URLs into chat or log them.

Authorization/token exchange uses fixed `auth.openai.com` HTTPS endpoints with normal TLS validation. Image requests use only `https://chatgpt.com/backend-api/codex/responses`, an honest package User-Agent, and disabled redirects. JWT account claims supply a validated routing header only; OpenAI authenticates the token. The extension does not import browser cookies, use the `openai` plan-sharing chat grant, or switch to API-key billing. Only backend-reported image metadata and allowlisted numeric usage counters are retained; token response bodies, HTTP error bodies, and raw auth-resolution errors are not shown. Known image request credentials are redacted from backend text.

Network work has a five-minute deadline and a 100 MiB response bound. Output images are limited to 32 MiB; input images must be regular files and are limited to 20 MiB each and 50 MiB in total. Image checks validate base64 and format signatures, not all image internals. Treat images as untrusted content when opening them in other software.

Generated files are created exclusively with user-only permissions. A repeated backend ID or existing destination produces a save warning rather than overwriting that file. Cancellation and stream failures do not trigger automatic generation retries because the remote operation may already have consumed quota.

At startup, `@mocito/install-telemetry` sends a best-effort install/update ping to the configured telemetry endpoint once per package version unless CI, Pi offline/telemetry settings, or `enableInstallTelemetry: false` disables it. It contains only the package name/version and parsed platform/runtime/architecture; it does not include prompts, file paths, configuration values, credentials, or provider responses.
