import { expect, test } from "vitest";

import { TelemetryRedaction } from "../../src/redaction.js";

test("redacts matching file reads in tool spans and subsequent generation history", () => {
  const redaction = new TelemetryRedaction({
    tools: [
      { name: "read", path: "**/.env*", input: "redact" },
      {
        name: "read",
        path: "**/.env.example",
        input: "as-is",
        output: "as-is",
      },
    ],
  });
  redaction.register("secret", "read", { filePath: "/app/.env" });
  redaction.register("public", "read", { filePath: "/app/.env.example" });

  expect(redaction.toolInput("read", { filePath: "/app/.env" })).toBe(
    "[REDACTED]",
  );
  expect(redaction.toolOutput("secret", "PASSWORD=abc")).toBe("[REDACTED]");
  expect(redaction.toolOutput("public", "example")).toBe("example");

  const history = [
    {
      role: "assistant",
      tool_calls: [
        { id: "secret", name: "read", arguments: '{"filePath":"/app/.env"}' },
      ],
    },
    { role: "tool", tool_call_id: "secret", content: "PASSWORD=abc" },
    { role: "tool", tool_call_id: "public", content: "example" },
    {
      type: "tool-result",
      toolCallId: "secret",
      output: { text: "PASSWORD=abc" },
    },
  ];
  const serialized = JSON.stringify(redaction.sanitize(history));
  expect(serialized).not.toContain("PASSWORD=abc");
  expect(serialized).not.toContain('/app/.env"');
  expect(serialized).toContain("example");
  expect(history[1]).toHaveProperty("content", "PASSWORD=abc");
});

test("unmatched tools stay as-is and earlier tool calls in a snapshot are discovered", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", path: "**/secrets/**" }],
  });
  const snapshot = [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "one",
          name: "read",
          arguments: '{"filePath":"/repo/secrets/token"}',
        },
      ],
    },
    { role: "tool", tool_call_id: "one", content: "sensitive" },
    { role: "tool", tool_call_id: "two", content: "ordinary" },
  ];
  expect(redaction.sanitize(snapshot)).toEqual([
    snapshot[0],
    { ...snapshot[1], content: "[REDACTED]" },
    snapshot[2],
  ]);
});

test("redacts real OpenCode 2 tool-call inputs and tool-result values", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", path: "**/.private", input: "redact" }],
  });
  const snapshot = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "call-1",
            name: "read",
            input: { filePath: "/app/.private" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "read",
            result: { type: "text", value: "PASSWORD=abc" },
          },
        ],
      },
    ],
  };

  expect(redaction.sanitize(snapshot)).toEqual({
    messages: [
      {
        role: "assistant",
        content: [{ ...snapshot.messages[0].content[0], input: "[REDACTED]" }],
      },
      {
        role: "tool",
        content: [{ ...snapshot.messages[1].content[0], result: "[REDACTED]" }],
      },
    ],
  });
  expect(snapshot.messages[1].content[0]).toHaveProperty(
    "result.value",
    "PASSWORD=abc",
  );
});

test("removes call policies when their session ends", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", output: "redact" }],
  });
  redaction.register("call-1", "read", {}, "session-1");
  redaction.register("call-2", "read", {}, "session-2");
  redaction.clearSession("session-1");

  expect(redaction.toolOutput("call-1", "visible")).toBe("visible");
  expect(redaction.toolOutput("call-2", "secret")).toBe("[REDACTED]");
});

test("redacts a named tool result even when its call was not observed", () => {
  const redaction = new TelemetryRedaction({
    tools: [
      { name: "read", path: "**/.env" },
      { name: "read", path: "**/.env.example", output: "as-is" },
    ],
  });
  const result = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: "unknown-call",
        name: "read",
        result: { type: "text", value: "PASSWORD=secret" },
      },
    ],
  };
  const expected = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: "unknown-call",
        name: "read",
        result: "[REDACTED]",
      },
    ],
  };
  expect(redaction.sanitize(result)).toEqual(expected);
  expect(
    new TelemetryRedaction({ tools: [{ name: "read" }] }).sanitize(result),
  ).toEqual(expected);
});

test("checks every path argument before sending a tool result as-is", () => {
  const redaction = new TelemetryRedaction({
    tools: [
      { name: "read", path: "**/.env*", input: "redact" },
      {
        name: "read",
        path: "**/.env.example",
        input: "as-is",
        output: "as-is",
      },
    ],
  });
  const args = {
    path: "/repo/.env.example",
    filePath: "/repo/.env",
  };
  redaction.register("sensitive", "read", args);

  expect(redaction.toolInput("read", args)).toBe("[REDACTED]");
  expect(redaction.toolOutput("sensitive", "PASSWORD=secret")).toBe(
    "[REDACTED]",
  );
});

test("redacts OpenCode 2 calls whose input is a JSON string", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", path: "**/.env", input: "redact" }],
  });
  const snapshot = {
    messages: [
      {
        type: "tool-call",
        id: "json-call",
        name: "read",
        input: '{"filePath":"/repo/.env"}',
      },
      {
        type: "tool-result",
        id: "json-call",
        name: "read",
        result: { type: "text", value: "PASSWORD=secret" },
      },
    ],
  };

  expect(redaction.sanitize(snapshot)).toEqual({
    messages: [
      { ...snapshot.messages[0], input: "[REDACTED]" },
      { ...snapshot.messages[1], result: "[REDACTED]" },
    ],
  });
});

test("a known call without a path does not suppress path-scoped redaction", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", path: "**/.env", input: "redact" }],
  });
  redaction.register("unknown-input", "read", undefined);

  expect(redaction.toolOutput("unknown-input", "PASSWORD=secret")).toBe(
    "[REDACTED]",
  );
  expect(
    redaction.sanitize({
      type: "tool-result",
      id: "unknown-input",
      name: "read",
      result: { type: "text", value: "PASSWORD=secret" },
    }),
  ).toEqual({
    type: "tool-result",
    id: "unknown-input",
    name: "read",
    result: "[REDACTED]",
  });
});

test("matches literal regex characters in file paths", () => {
  const redaction = new TelemetryRedaction({
    tools: [{ name: "read", path: "**/secret?.txt" }],
  });
  redaction.register("literal-question", "read", {
    filePath: "/repo/secret?.txt",
  });
  redaction.register("different-file", "read", {
    filePath: "/repo/secrett.txt",
  });

  expect(redaction.toolOutput("literal-question", "private")).toBe(
    "[REDACTED]",
  );
  expect(redaction.toolOutput("different-file", "public")).toBe("public");
});
