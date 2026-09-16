# Development and Maintenance

See the [main CONTRIBUTING.md](https://github.com/langfuse/langfuse/blob/main/CONTRIBUTING.md) to learn how to contribute to Langfuse and its integrations.

## Local Development

Install dependencies:

```bash
pnpm install
```

Build the plugin:

```bash
pnpm run build
```

To test the plugin globally, add its built entrypoint to `~/.config/opencode/opencode.jsonc`. Replace `/path/to/langfuse-opencode` with the absolute path to this repository.

For OpenCode 2, configure the V2 entrypoint:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/langfuse-opencode/dist/v2"],
}
```

For OpenCode 1, configure the V1 entrypoint instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": {
    "openTelemetry": true,
  },
  "plugin": ["/path/to/langfuse-opencode/dist/v1/index.js"],
}
```

Rebuild the package after making changes and restart OpenCode before testing:

```bash
pnpm run build
opencode service restart
```

Format files:

```bash
pnpm run format
```

Check formatting:

```bash
pnpm run format:check
```

tsdown bundles the plugins and their runtime dependencies into `dist/v1/index.js` and `dist/v2/index.js`. Do not edit generated files in `dist/` by hand.

## Releasing

1. From a clean, up-to-date `main` branch, bump the version and push the resulting commit and tag:

   ```bash
   pnpm version 1.2.3 --message "Release v%s"
   git push origin main --follow-tags
   ```

   `pnpm version` updates `package.json`, creates a commit titled `Release v1.2.3`, and tags it as `v1.2.3`. The release workflow verifies the version, builds and tests the package, stages it on npm with provenance, and creates a draft GitHub release.

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
