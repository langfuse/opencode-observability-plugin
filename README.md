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
  "userId": "your-user-id"
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is not set, the plugin uses `https://cloud.langfuse.com`. If `environment` is not set, it uses `development`.

You can also set credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
export LANGFUSE_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

If both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, the plugin uses environment variables instead of reading the config file. Optional values can be supplied either way.

## Redacting tool data

Add `redaction` to `~/.config/opencode/opencode-langfuse.json` (also when credentials come from environment variables):

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "redaction": {
    "tools": [
      { "name": "read", "path": "**/.env*", "input": "redact" },
      {
        "name": "read",
        "path": "**/.env.example",
        "input": "as-is",
        "output": "as-is"
      },
      { "name": "bash", "output": "redact" }
    ]
  }
}
```

Rules match the tool name exactly (or `*` for every tool). An optional `path` glob matches the tool input's `filePath`, `path`, or `filename` (with `*` matching within a directory and `**` across directories). The last matching rule wins for each path; when multiple path arguments are present, a redaction on any of them wins. `input` and `output` accept `"as-is"` or `"redact"`; a matching rule defaults to sending the input as-is and replacing the output with `"[REDACTED]"`. Without a matching rule, data is sent as-is. Redaction covers tool observations and tool results copied into later generation inputs in both OpenCode versions. To hide the file path or other tool arguments too, set `"input": "redact"`.

These rules do not redact text that the user or assistant independently includes in messages or reasoning. If a tool call's path is unavailable (including results without their calls), any potentially matching path rule redacts its input and/or output. If the file cannot be read or parsed, tracing stops rather than silently ignoring potentially configured redaction rules. Restart OpenCode after changing the file.

## Contributing

See the [contributing guide](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
