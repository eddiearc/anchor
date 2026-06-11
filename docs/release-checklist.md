# Anchor Release Checklist

Use this checklist before a human performs a real public npm publish. R20 only verifies readiness; it does not publish.

## Package Identity

- Confirm the publish target is `@eddiearc/anchor`.
- Confirm the unscoped `anchor` package remains occupied by another package and is not the publish target.
- Confirm the npm account performing the release owns or can publish to the `@eddiearc` scope.
- Confirm `package.json` has the intended version and `publishConfig.access` is `public`.

## Build And Test

- Run `pnpm install` from a clean checkout.
- Run `pnpm build`.
- Run `pnpm test`.
- Run `pnpm pack:check`.
- Run `pnpm publish:dry-run`.

## Tarball Review

- Inspect `npm pack --json` output.
- Confirm the tarball contains only publishable files such as `README.md`, `dist/`, and `package.json`.
- Confirm the tarball excludes `.anchor/`, worktrees, tests, `src/`, logs, `.env`, secret files, and local artifacts.
- Install the tarball into an isolated prefix and run `anchor --version`, `anchor --help`, and the quickstart smoke.

## Human Publish Step

- Confirm changelog or release notes are ready.
- Confirm the Git tag to create for the version.
- Confirm the final command is run by a human:

```bash
npm publish --access public
```

- After publish, run:

```bash
npm view @eddiearc/anchor version
npm install -g @eddiearc/anchor
anchor --version
anchor --help
```

## Do Not Publish If

- The npm scope ownership is unclear.
- The version is already published.
- The dry run fails for reasons other than expected auth or ownership checks.
- The tarball contains source, tests, workspace artifacts, logs, `.env`, or secrets.
- The isolated install smoke fails.
