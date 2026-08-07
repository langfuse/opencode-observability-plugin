# Development and Maintenance

## Local Development

This package is currently marked as private. For local development, use a local plugin path in your OpenCode config instead of the package name.

Install dependencies:

```bash
pnpm install
```

Build the plugin:

```bash
pnpm run build
```

Format files:

```bash
pnpm run format
```

Check formatting:

```bash
pnpm run format:check
```

tsdown bundles the plugin and its runtime dependencies into `dist/index.js`. Do not edit generated files in `dist/` by hand.

## Releasing

1. From a clean, up-to-date `main` branch, bump the version and push the resulting commit and tag:

   ```bash
   pnpm version 1.2.3
   git push origin main --follow-tags
   ```

   `pnpm version` updates `package.json`, creates a version commit, and tags it as `v1.2.3`. The release workflow verifies the version, builds and tests the package, stages it on npm with provenance, and creates a draft GitHub release.

2. Review the staged package on npmjs.com or with the npm CLI:

   ```bash
   npm stage list @langfuse/opencode-observability-plugin
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

3. Approve the staged package using an npm account with publish access and 2FA enabled:

   ```bash
   npm stage approve <stage-id>
   ```

4. Review and publish the draft GitHub release created by the workflow.

Do not approve the npm package or publish the GitHub draft until both staged artifacts have been reviewed. If the workflow fails before staging, fix the problem and move the tag to the corrected release commit. If staging succeeded, do not rerun the workflow with the same version; staged and published versions cannot be staged again.
