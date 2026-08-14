# AGENTS.md — story-player

- Zero runtime dependencies and zero browser build: preserve the complete
  `browser/` static tree and its relative ESM imports.
- The shell is version-neutral. `browser/shell/**` dispatches by
  `storylang_version` and must not import a version directly.
- `browser/v0/core/**` is pure logic. Only
  `browser/v0/app/stage/stage-renderer.mjs` touches stage DOM.
- Treat `@fabrolabs/story-player/host` and
  `@fabrolabs/story-player/v0/tooling` as the only public Node APIs.
- Preserve deterministic behavior. A policy change requires contract tests and
  downstream mobile parity regeneration.
- Never commit credentials, `.npmrc`, registry publication configuration, or a
  credential-bearing artifact URL.
- Release immutable versions from a matching human-created GitHub Release tag;
  upload one public npm-compatible `.tgz` and supersede a bad release with a
  higher version. Never clobber an existing release asset.
- Run `npm ci --ignore-scripts`, the full tests, dry-run pack inspection, and
  the clean-tarball and clean-install verifiers before release.
- Keep package verification provider-neutral. GitHub hosts the current release,
  but a local path or credential-free HTTPS `.tgz` from another host must obey
  the same install contract.
