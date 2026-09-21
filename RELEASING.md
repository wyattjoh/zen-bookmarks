# Releasing

[`release-please`](https://github.com/googleapis/release-please) manages version bumps, `CHANGELOG.md`, Git tags, and GitHub releases. The release workflow publishes `@wyattjoh/zen-bookmarks` to npm with npm Trusted Publishing (OIDC), so it does not use a long-lived npm token.

## One-time bootstrap

The package is currently at `0.2.0` and has not yet been published. Trusted Publishing can only be configured after the package exists on npm.

After these release-automation changes reach `main`:

1. Check out the exact `main` revision and run the release checks:

   ```bash
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   npm pack --dry-run
   ```

2. Authenticate to npm with an account that can publish under the `@wyattjoh` scope, then create the package with a one-time manual publish:

   ```bash
   npm publish --access public
   ```

3. On npmjs.com, open **@wyattjoh/zen-bookmarks → Settings → Trusted Publisher** and add a GitHub Actions publisher with:

   - Organization or user: `wyattjoh`
   - Repository: `zen-bookmarks`
   - Workflow filename: `release.yml`
   - Allowed action: `npm publish`
   - Environment: leave blank

4. In GitHub, enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.

After a successful OIDC publish, npm recommends setting package publishing access to **Require two-factor authentication and disallow tokens**.

## Normal releases

Use Conventional Commits on `main`:

- `fix:` creates a patch release.
- `feat:` creates a minor release, including before 1.0.
- `feat!:` or a `BREAKING CHANGE:` footer creates a breaking release.
- `chore:`, `docs:`, `ci:`, `test:`, and `refactor:` do not trigger a release by default.

On a qualifying push to `main`, `.github/workflows/release.yml` opens or updates a release pull request. Merging that pull request creates the GitHub release and publishes the package to npm from the same workflow.

The initial `bootstrap-sha` in `release-please-config.json` intentionally excludes commits that predate this setup. Once release-please has created its first release, it uses its own release history and ignores that bootstrap boundary.

Release-please pull requests created with `GITHUB_TOKEN` do not trigger the normal pull-request CI workflow. The publish job therefore repeats dependency installation, tests, typechecking, and package-content verification before publishing.
