# omp-codex-image-gen

Generate and edit images inside [Oh My Pi](https://github.com/can1357/oh-my-pi) with **gpt-image-2** and your existing ChatGPT Codex login.

## Features

- Generate PNG, JPEG, and WebP images.
- Edit with up to five local or recent conversation images.
- Return images inline and optionally save them by project, session, or custom directory.
- Reuse OMP's `openai-codex` authentication; no separate API key is required.
- Include an `imagegen` skill with prompting and transparent-background workflows.

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

Select **ChatGPT Plus/Pro (Codex)**, then ask OMP to create an image:

```text
Generate a pixel-art sword icon with a blue blade and gold hilt.
```

OMP invokes `codex_generate_image`. The routing model defaults to `gpt-5.5`; image generation is performed by `gpt-image-2`.

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
  "model": "gpt-5.5"
}
```

| Key | Default | Description |
| --- | --- | --- |
| `save` | `"global"` | `none`, `project`, `global`, or `custom` |
| `saveDir` | — | Directory used by `custom` mode |
| `model` | `"gpt-5.5"` | Codex routing model |

Environment overrides:

- `OMP_CODEX_IMAGE_SAVE_MODE`
- `OMP_CODEX_IMAGE_SAVE_DIR`

## Save modes

| Mode | Destination |
| --- | --- |
| `none` | Inline only |
| `project` | `<project>/.omp/generated-images/<session-id>/` |
| `global` | `<omp-agent-dir>/generated-images/<session-id>/` |
| `custom` | `<saveDir>/<session-id>/` |

## Tool parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` | string | Required image prompt |
| `model` | string | Optional routing-model override |
| `outputFormat` | string | `png`, `jpeg`, or `webp` |
| `save` | string | Save-mode override |
| `saveDir` | string | Directory for `custom` mode |
| `referencedImagePaths` | string[] | Up to five local edit inputs |
| `numLastImagesToInclude` | integer | One to five recent conversation images; mutually exclusive with paths |

## Development

```sh
npm install
npm test
npm run check
npm run pack:dry-run
```

The normal tool path uses OMP's Codex OAuth token. The bundled Python CLI fallback is separate and requires `OPENAI_API_KEY`.

## License and attribution

Apache-2.0. This is an OMP port of [`pi-codex-image-gen`](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-image-gen) by Jose Mocito.

The bundled imagegen skill includes files derived from [OpenAI Codex](https://github.com/openai/codex). See [NOTICE](./NOTICE) and `skills/imagegen/LICENSE.txt`.
