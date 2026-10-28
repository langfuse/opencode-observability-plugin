# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

## Quick Start

For OpenCode 2, enable the plugin in your configuration:

```json
{
  "plugins": ["@langfuse/opencode-observability-plugin@latest"]
}
```

For OpenCode 1, use the same package in your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@langfuse/opencode-observability-plugin@latest"]
}
```

Restart OpenCode after changing the config.

## Supported Versions

Requires Node.js 22 or newer and Langfuse Cloud or self-hosted Langfuse 4.59.0
or newer.

The default package entrypoint supports both OpenCode 1 and OpenCode 2. OpenCode
1 calls the plugin's `server()` implementation, while OpenCode 2 calls its
`setup()` implementation. The `/v1` and `/v2` entrypoints remain available for
direct imports.

Validated versions and entrypoints:

- OpenCode `2.0.4` and newer: `@langfuse/opencode-observability-plugin`
- OpenCode `1.18.29` and newer: `@langfuse/opencode-observability-plugin`

## Langfuse Credentials

Create `~/.config/opencode/opencode-langfuse.json` with your Langfuse credentials.

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development",
  "userId": "your-user-id",
  "tags": ["app:my-app"]
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is not set, the plugin uses `https://cloud.langfuse.com`. If `environment` is not set, it uses `development`.

`tags` sets Langfuse trace tags on every trace. It accepts an array of non-empty strings and can also be provided as a plugin option in the OpenCode config, which takes precedence over the config file:

```json
{
  "plugins": [
    {
      "package": "@langfuse/opencode-observability-plugin",
      "options": {
        "tags": ["app:my-app"]
      }
    }
  ]
}
```

For OpenCode 1, use the same option under `plugin`:

```json
{
  "plugin": [
    ["@langfuse/opencode-observability-plugin", { "tags": ["app:my-app"] }]
  ]
}
```

You can also set credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
export LANGFUSE_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

If both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are non-empty, the plugin uses environment variables instead of reading the config file, so config-file `tags` are ignored too. To set tags when using environment credentials, provide `tags` as a plugin option in the OpenCode config. There is no environment variable for tags.

## Contributing

See the [contributing guide](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
