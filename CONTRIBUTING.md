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
