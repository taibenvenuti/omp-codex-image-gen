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

Run `/login` for `openai-codex`, then ask OMP to generate an image. Live generation consumes image quota; unit tests do not make external requests.

Validate the optional Python fallback without an API key:

```sh
python3 skills/imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/test.png --dry-run
python3 skills/imagegen/scripts/remove_chroma_key.py --help
```

Keep tool parameters, tests, README documentation, and changelog entries synchronized. Do not modify the vendored Python helper without documenting why.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
