# Langfuse OpenCode Plugin

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

## Quick Start

Enable the plugin in your `opencode.json` or `opencode.jsonc`:

```json
{
  "experimental": {
    "openTelemetry": true
  },
  "plugin": ["@langfuse/opencode-observability-plugin@latest"]
}
```

Restart OpenCode after changing the config.

## Supported Versions

We aim to support a wide range of OpenCode v1 versions, including older event
payloads that are no longer part of the current OpenCode internals.

Validated versions:

- `1.15.13`
- `1.18.19`

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

## Tool Observation Names

Skill and subagent tool observations include the skill name or subagent type so
Langfuse dashboards can group and filter their metrics by observation name:

- `skill` with input `{ "name": "resolve-dependencies" }` is named `skill:resolve-dependencies`.
- `task` with input `{ "subagent_type": "developer" }` is named `task:developer`.

Leading and trailing whitespace is trimmed from the name. Missing, blank, or
non-string values fall back to `skill` or `task`. Other tool names are unchanged.
The original tool input and the metadata `tool` field remain unchanged.

## Contributing

See the [contributing guide](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
