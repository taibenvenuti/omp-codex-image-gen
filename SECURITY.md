# Security Policy

> Modified by Oh My Pi contributors from pi-codex-image-gen (Apache-2.0).

Security fixes are provided for the latest released version of `omp-codex-image-gen`.

Report suspected vulnerabilities privately to the package maintainer. Do not open a public issue containing credentials or exploit details.

OMP plugins execute with the permissions of the local user. Review plugins before installation.

This plugin obtains a short-lived token from OMP's existing `openai-codex` login and sends it only to the Codex Responses API. It does not write or log the token. Never commit API keys, tokens, or decoded JWT payloads.
