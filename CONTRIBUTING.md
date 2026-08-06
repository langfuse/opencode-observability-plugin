# Contributing

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
