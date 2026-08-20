import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";

import { trace } from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

type OtlpValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number;
};

type OtlpSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: OtlpValue }[];
  status?: { code?: number; message?: string };
  events?: { name: string }[];
};

type CapturedRequest = {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: {
    resourceSpans: {
      resource?: { attributes?: { key: string; value: OtlpValue }[] };
      scopeSpans: { spans: OtlpSpan[] }[];
    }[];
  };
};

type Plugin = (typeof import("../../dist/index.js"))["default"];
type PluginHooks = Awaited<ReturnType<Plugin>>;
type PluginEvent = Parameters<NonNullable<PluginHooks["event"]>>[0]["event"];
type SessionNextEvent =
  | {
      id: string;
      type: "session.next.step.started";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID?: string;
        agent: string;
        model: {
          id: string;
          providerID: string;
          variant?: string;
        };
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        error: { message: string };
      };
    }
  | {
      id: string;
      type: "session.next.tool.called";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID?: string;
        callID: string;
        tool: string;
        input: Record<string, unknown>;
        provider: { executed: boolean; metadata?: unknown };
      };
    }
  | {
      id: string;
      type: "session.next.retried";
      properties: {
        sessionID: string;
        timestamp: number;
        attempt: number;
        error: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.reasoning.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        reasoningID: string;
        text: string;
      };
    }
  | {
      id: string;
      type: "session.next.compaction.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        text: string;
        include?: string;
      };
    };
type TestPluginEvent =
  | PluginEvent
  | SessionNextEvent
  | {
      type: "session.error";
      properties: {
        sessionID: string;
        error: { name: "MessageAbortedError"; message: string };
      };
    };

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof packageJson.version !== "string") {
  throw new Error("Expected package.json to contain a version");
}

const packageVersion = packageJson.version;

const originalEnvironment = {
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
  legacyBaseUrl: process.env.LANGFUSE_BASEURL,
  environment: process.env.LANGFUSE_ENVIRONMENT,
  userId: process.env.LANGFUSE_USER_ID,
};

const requests: CapturedRequest[] = [];
const collectorErrors: unknown[] = [];
let server: Server;
let hooks: PluginHooks;
let plugin: Plugin;
let collectorStatus = 200;
let hooksDisposed = false;
let collectorBaseUrl: string;
let toolListCalls = 0;
let toolListShouldFail = false;

const startedAt = 1_750_000_000_000;

const getSpans = (request: CapturedRequest) =>
  request.body.resourceSpans.flatMap((resourceSpan) =>
    resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
  );

const getAttributes = (span: OtlpSpan) =>
  Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? value.intValue,
    ]),
  );

const getResourceAttributes = (request: CapturedRequest) =>
  Object.fromEntries(
    request.body.resourceSpans.flatMap(
      (resourceSpan) =>
        resourceSpan.resource?.attributes?.map(({ key, value }) => [
          key,
          value.stringValue ?? value.boolValue ?? value.intValue,
        ]) ?? [],
    ),
  );

const getJsonAttribute = (span: OtlpSpan, key: string) => {
  const value = getAttributes(span)[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${span.name} attribute ${key} to be JSON`);
  }

  return JSON.parse(value) as unknown;
};

const getSpan = (spans: OtlpSpan[], name: string) => {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(
      `Expected a ${name} span, received: ${spans
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }

  return span;
};

const getSessionSpan = (spans: OtlpSpan[], name: string, sessionID: string) => {
  const span = spans.find(
    (candidate) =>
      candidate.name === name &&
      getAttributes(candidate)["session.id"] === sessionID,
  );

  if (!span) {
    throw new Error(`Expected a ${name} span for session ${sessionID}`);
  }

  return span;
};

const emitEvent = async (event: TestPluginEvent) => {
  // These events are emitted by current OpenCode versions but are not yet part of
  // the PluginEvent union exported by our pinned @opencode-ai/plugin version.
  await hooks.event?.({ event: event as PluginEvent });
};

const flushSession = async (sessionID: string) => {
  const requestCount = requests.length;
  await emitEvent({ type: "session.idle", properties: { sessionID } });
  const exportedRequests = requests.slice(requestCount);

  expect(collectorErrors).toEqual([]);
  expect(exportedRequests.length).toBeGreaterThan(0);

  return {
    requests: exportedRequests,
    spans: exportedRequests.flatMap(getSpans),
  };
};

const sendUserMessage = async (input: {
  sessionID: string;
  messageID: string;
  text: string;
  started: number;
}) => {
  await hooks["chat.message"]?.(
    {
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent: "build",
      model: { providerID: "test-provider", modelID: "test-model" },
    },
    {
      message: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: { created: input.started },
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
      },
      parts: [
        {
          id: `${input.messageID}-part`,
          sessionID: input.sessionID,
          messageID: input.messageID,
          type: "text",
          text: input.text,
        },
      ],
    },
  );
};

const startGeneration = async (input: {
  id: string;
  sessionID: string;
  assistantMessageID?: string;
  started: number;
  snapshot?: string;
}) => {
  await emitEvent({
    id: input.id,
    type: "session.next.step.started",
    properties: {
      sessionID: input.sessionID,
      timestamp: input.started,
      assistantMessageID: input.assistantMessageID,
      agent: "build",
      model: {
        id: "test-model",
        providerID: "test-provider",
        variant: "high",
      },
      snapshot: input.snapshot,
    },
  });
};

const startAssistantMessage = async (input: {
  sessionID: string;
  userMessageID: string;
  assistantMessageID: string;
  started: number;
}) => {
  await emitEvent({
    type: "message.updated",
    properties: {
      info: {
        id: input.assistantMessageID,
        sessionID: input.sessionID,
        parentID: input.userMessageID,
        role: "assistant",
        mode: "build",
        modelID: "test-model",
        providerID: "test-provider",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: input.started },
      },
    },
  });
};

const completeGeneration = async (input: {
  sessionID: string;
  userMessageID: string;
  assistantMessageID: string;
  started: number;
  completed: number;
  text?: string;
}) => {
  if (input.text ?? "") {
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: `${input.assistantMessageID}-part`,
          sessionID: input.sessionID,
          messageID: input.assistantMessageID,
          type: "text",
          text: input.text,
        },
      },
    });
  }

  await emitEvent({
    type: "message.updated",
    properties: {
      info: {
        id: input.assistantMessageID,
        sessionID: input.sessionID,
        parentID: input.userMessageID,
        role: "assistant",
        mode: "build",
        modelID: "test-model",
        providerID: "test-provider",
        path: { cwd: "/test", root: "/test" },
        finish: "stop",
        cost: 0.01,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 2,
          cache: { read: 3, write: 1 },
        },
        time: { created: input.started, completed: input.completed },
      },
    },
  });
};

const createHooks = async (baseUrl: string) => {
  process.env.LANGFUSE_BASE_URL = baseUrl;
  const client = {
    app: {
      log: () => Promise.resolve(),
    },
    tool: {
      list: () => {
        toolListCalls += 1;

        if (toolListShouldFail) {
          return Promise.reject(new Error("Tool discovery unavailable"));
        }

        return Promise.resolve({
          data: [
            {
              id: "read",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
            {
              id: "webfetch",
              description: "Fetch a URL",
              parameters: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
              },
            },
          ],
        });
      },
    },
  } as unknown as Parameters<Plugin>[0]["client"];

  return plugin({ client } as Parameters<Plugin>[0]);
};

const disposeHooks = async () => {
  if (hooksDisposed) {
    return;
  }

  hooksDisposed = true;
  try {
    await hooks.dispose?.();
  } finally {
    trace.disable();
  }
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("error", (error) => {
      collectorErrors.push(error);
    });
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as CapturedRequest["body"],
        });
        response.writeHead(collectorStatus, {
          "content-type": "application/json",
        });
        response.end("{}");
      } catch (error) {
        collectorErrors.push(error);
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"invalid OTLP payload"}');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test collector to listen on a TCP port");
  }

  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
  collectorBaseUrl = `http://127.0.0.1:${address.port}`;
  process.env.LANGFUSE_BASE_URL = collectorBaseUrl;
  process.env.LANGFUSE_ENVIRONMENT = "integration-test";
  process.env.LANGFUSE_USER_ID = "test-user";
  delete process.env.LANGFUSE_BASEURL;

  const builtPluginUrl = new URL("../../dist/index.js", import.meta.url);
  const builtPlugin: unknown = await import(builtPluginUrl.href);
  plugin = (builtPlugin as { default: Plugin }).default;
});

beforeEach(async () => {
  requests.length = 0;
  collectorErrors.length = 0;
  collectorStatus = 200;
  hooksDisposed = false;
  toolListCalls = 0;
  toolListShouldFail = false;
  hooks = await createHooks(collectorBaseUrl);
});

afterEach(async () => {
  await disposeHooks();
});

afterAll(async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Existing violation tracked for incremental cleanup.
        error ? reject(error) : resolve();
      });
    });
  } finally {
    for (const [name, value] of Object.entries({
      LANGFUSE_PUBLIC_KEY: originalEnvironment.publicKey,
      LANGFUSE_SECRET_KEY: originalEnvironment.secretKey,
      LANGFUSE_BASE_URL: originalEnvironment.baseUrl,
      LANGFUSE_BASEURL: originalEnvironment.legacyBaseUrl,
      LANGFUSE_ENVIRONMENT: originalEnvironment.environment,
      LANGFUSE_USER_ID: originalEnvironment.userId,
    })) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Existing violation tracked for incremental cleanup.
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

// eslint-disable-next-line @typescript-eslint/no-deprecated -- Existing violation tracked for incremental cleanup.
describe.sequential("built plugin", () => {
  test("exports a complete multi-turn OpenCode session", async () => {
    const sessionID = "happy-session";
    const started = startedAt;
    const firstUserMessageID = "happy-user-1";
    const firstAssistantMessageID = "happy-assistant-1";

    await sendUserMessage({
      sessionID,
      messageID: firstUserMessageID,
      text: "Inspect the repository",
      started,
    });
    await startGeneration({
      id: "happy-step-1",
      sessionID,
      started: started + 100,
      snapshot: "snapshot-1",
    });
    await completeGeneration({
      sessionID,
      userMessageID: firstUserMessageID,
      assistantMessageID: firstAssistantMessageID,
      started: started + 100,
      completed: started + 800,
      text: "Repository inspected",
    });

    const secondUserMessageID = "happy-user-2";
    const secondAssistantMessageID = "happy-assistant-2";
    await sendUserMessage({
      sessionID,
      messageID: secondUserMessageID,
      text: "Summarize it",
      started: started + 1_000,
    });
    await startGeneration({
      id: "happy-step-2",
      sessionID,
      started: started + 1_100,
    });
    await completeGeneration({
      sessionID,
      userMessageID: secondUserMessageID,
      assistantMessageID: secondAssistantMessageID,
      started: started + 1_100,
      completed: started + 1_500,
      text: "A concise summary",
    });

    const { requests: exportedRequests, spans } = await flushSession(sessionID);

    for (const request of exportedRequests) {
      expect(request).toMatchObject({
        method: "POST",
        url: "/api/public/otel/v1/traces",
        headers: {
          authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
          "content-type": "application/json",
        },
      });
    }
    expect(spans.map((span) => span.name).sort()).toEqual(
      [
        "opencode.turn",
        "opencode.message.user",
        "opencode.generation",
        "opencode.turn",
        "opencode.message.user",
        "opencode.generation",
      ].sort(),
    );
    for (const span of spans.filter(
      (span) =>
        span.name === "opencode.turn" || span.name === "opencode.message.user",
    )) {
      expect(getJsonAttribute(span, "langfuse.observation.input")).toEqual([
        {
          role: "user",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Existing violation tracked for incremental cleanup.
          content: expect.any(Array),
        },
      ]);
    }
    for (const turn of spans.filter((span) => span.name === "opencode.turn")) {
      expect(getAttributes(turn)).toMatchObject({
        "langfuse.observation.type": "agent",
      });
    }

    const firstGeneration = spans
      .filter((span) => span.name === "opencode.generation")
      .find((span) => {
        const metadata = getJsonAttribute(
          span,
          "langfuse.observation.metadata",
        );
        return (
          typeof metadata === "object" &&
          metadata !== null &&
          "messageID" in metadata &&
          metadata.messageID === firstAssistantMessageID
        );
      });
    if (!firstGeneration) {
      throw new Error("Expected the first generation span");
    }

    expect(getAttributes(firstGeneration)).toMatchObject({
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "test-model",
      "langfuse.plugin.version": packageVersion,
      "langfuse.user.id": "test-user",
      "session.id": sessionID,
    });
    expect(
      getJsonAttribute(firstGeneration, "langfuse.observation.input"),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the repository" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
          {
            name: "webfetch",
            description: "Fetch a URL",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            },
          },
        ],
      },
    ]);
    expect(toolListCalls).toBe(1);
    expect(
      getJsonAttribute(firstGeneration, "langfuse.observation.usage_details"),
    ).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cache_read: 3,
      cache_write: 1,
      total: 17,
    });
    expect(
      getJsonAttribute(firstGeneration, "langfuse.observation.cost_details"),
    ).toEqual({ total: 0.01 });
    expect(
      getJsonAttribute(firstGeneration, "langfuse.observation.metadata"),
    ).toMatchObject({
      messageID: firstAssistantMessageID,
      parentID: firstUserMessageID,
      providerID: "test-provider",
      variant: "high",
      snapshot: "snapshot-1",
    });
  });

  test("exports reasoning, tool, retry, and compaction spans", async () => {
    const sessionID = "nested-observations-session";
    const userMessageID = "nested-observations-user";
    const assistantMessageID = "nested-observations-assistant";
    const started = startedAt;

    await sendUserMessage({
      sessionID,
      messageID: userMessageID,
      text: "Inspect the repository",
      started,
    });
    await startGeneration({
      id: "nested-observations-step",
      sessionID,
      started: started + 100,
    });
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "nested-observations-reasoning-part",
          sessionID,
          messageID: assistantMessageID,
          type: "reasoning",
          text: "I should inspect the README.",
          time: { start: started + 150, end: started + 200 },
        },
      },
    });
    await emitEvent({
      id: "nested-observations-reasoning-event",
      type: "session.next.reasoning.ended",
      properties: {
        sessionID,
        timestamp: started + 250,
        assistantMessageID,
        reasoningID: "nested-observations-reasoning-explicit",
        text: "The README contains the project overview.",
      },
    });
    await emitEvent({
      id: "nested-observations-read-called",
      type: "session.next.tool.called",
      properties: {
        sessionID,
        timestamp: started + 260,
        assistantMessageID,
        callID: "nested-observations-call",
        tool: "read",
        input: { path: "README.md" },
        provider: { executed: false },
      },
    });
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: "nested-observations-call", tool: "read" },
      { args: { path: "README.md" } },
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: "nested-observations-call",
        tool: "read",
        args: { path: "README.md" },
      },
      { title: "README.md", output: "# Project", metadata: {} },
    );
    const mcpCallID = "nested-observations-mcp-call";
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: mcpCallID, tool: "mcp_test_tool" },
      { args: { query: "test" } },
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: mcpCallID,
        tool: "mcp_test_tool",
        args: { query: "test" },
      },
      {
        content: [
          { type: "text", text: "MCP tool result" },
          {
            type: "resource",
            resource: {
              uri: "foo://bar",
              text: "MCP resource contents",
            },
          },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      } as unknown as Parameters<
        NonNullable<PluginHooks["tool.execute.after"]>
      >[1],
    );
    const failedMcpCallID = "nested-observations-failed-mcp-call";
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: failedMcpCallID, tool: "mcp_failing_tool" },
      { args: { query: "fail" } },
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: failedMcpCallID,
        tool: "mcp_failing_tool",
        args: { query: "fail" },
      },
      {
        content: [{ type: "text", text: "MCP tool failed" }],
        isError: true,
      } as unknown as Parameters<
        NonNullable<PluginHooks["tool.execute.after"]>
      >[1],
    );
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "nested-observations-read-part",
          sessionID,
          messageID: assistantMessageID,
          type: "tool",
          callID: "nested-observations-call",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "README.md" },
            title: "README.md",
            output: "# Project",
            metadata: {},
            time: { start: started + 260, end: started + 280 },
          },
        },
      },
    });
    const failedToolStarted = Date.now();
    const failedToolEnded = failedToolStarted + 5_000;
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "timed-out-webfetch-part",
          sessionID,
          messageID: assistantMessageID,
          type: "tool",
          callID: "timed-out-webfetch",
          tool: "webfetch",
          state: {
            status: "error",
            input: { url: "https://example.com", timeout: 5 },
            error: "Tool execution timed out after 5 seconds",
            time: { start: failedToolStarted, end: failedToolEnded },
          },
        },
      },
    });
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: "timed-out-webfetch",
        tool: "webfetch",
        args: { url: "https://example.com", timeout: 5 },
      },
      { title: "Web fetch", output: "late output", metadata: {} },
    );
    await emitEvent({
      id: "nested-observations-retry",
      type: "session.next.retried",
      properties: {
        sessionID,
        timestamp: started + 300,
        attempt: 2,
        error: { message: "temporary failure" },
      },
    });
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID,
      started: started + 100,
      completed: started + 800,
      text: "Repository inspected",
    });
    await emitEvent({
      id: "nested-observations-compaction",
      type: "session.next.compaction.ended",
      properties: {
        sessionID,
        timestamp: started + 900,
        text: "Repository context",
        include: "README.md",
      },
    });

    const { spans } = await flushSession(sessionID);
    expect(spans.map((span) => span.name).sort()).toEqual(
      [
        "opencode.turn",
        "opencode.message.user",
        "opencode.generation",
        "read",
        "mcp_test_tool",
        "mcp_failing_tool",
        "webfetch",
        "opencode.generation.retry",
        "opencode.generation.compaction",
      ].sort(),
    );

    const generation = getSpan(spans, "opencode.generation");
    expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual(
      [
        {
          role: "assistant",
          content: "Repository inspected",
          thinking: [
            {
              type: "thinking",
              content: "I should inspect the README.",
            },
            {
              type: "thinking",
              content: "The README contains the project overview.",
            },
          ],
          tool_calls: [
            {
              id: "nested-observations-call",
              name: "read",
              arguments: JSON.stringify({ path: "README.md" }),
            },
            {
              id: "timed-out-webfetch",
              name: "webfetch",
              arguments: JSON.stringify({
                url: "https://example.com",
                timeout: 5,
              }),
            },
          ],
        },
      ],
    );

    const tool = getSpan(spans, "read");
    expect(getJsonAttribute(tool, "langfuse.observation.input")).toEqual({
      path: "README.md",
    });
    expect(getJsonAttribute(tool, "langfuse.observation.output")).toEqual({
      title: "README.md",
      output: "# Project",
    });
    const mcpTool = getSpan(spans, "mcp_test_tool");
    expect(getJsonAttribute(mcpTool, "langfuse.observation.output")).toEqual({
      title: "mcp_test_tool",
      output: "MCP tool result\n\nMCP resource contents",
    });
    const failedMcpTool = getSpan(spans, "mcp_failing_tool");
    expect(failedMcpTool.status).toEqual({
      code: 2,
      message: "MCP tool failed",
    });
    expect(
      getJsonAttribute(failedMcpTool, "langfuse.observation.output"),
    ).toEqual({ error: "MCP tool failed" });
    expect(tool.traceId).toBe(generation.traceId);
    expect(tool.parentSpanId).toBe(generation.spanId);

    const failedTool = getSpan(spans, "webfetch");
    expect(failedTool.endTimeUnixNano).toBe(
      (BigInt(failedToolEnded) * 1_000_000n).toString(),
    );
    expect(failedTool.status).toEqual({
      code: 2,
      message: "Tool execution timed out after 5 seconds",
    });
    expect(getJsonAttribute(failedTool, "langfuse.observation.output")).toEqual(
      { error: "Tool execution timed out after 5 seconds" },
    );

    const retry = getSpan(spans, "opencode.generation.retry");
    expect(getJsonAttribute(retry, "langfuse.observation.metadata")).toEqual({
      attempt: 2,
    });
    expect(retry.parentSpanId).toBe(generation.spanId);

    const compaction = getSpan(spans, "opencode.generation.compaction");
    expect(getJsonAttribute(compaction, "langfuse.observation.output")).toEqual(
      {
        text: "Repository context",
      },
    );
    expect(compaction.parentSpanId).toBe(generation.spanId);

    expect(
      spans.filter((span) => span.name === "opencode.generation.reasoning"),
    ).toHaveLength(0);
  });

  test("links child agent sessions to the parent trace", async () => {
    const parentSessionID = "parent-agent-session";
    const childSessionID = "child-agent-session";
    const parentUserMessageID = "parent-agent-user";
    const parentAssistantMessageID = "parent-agent-assistant";
    const childUserMessageID = "child-agent-user";
    const childAssistantMessageID = "child-agent-assistant";
    const started = startedAt;

    await sendUserMessage({
      sessionID: parentSessionID,
      messageID: parentUserMessageID,
      text: "Delegate this investigation",
      started,
    });
    await startGeneration({
      id: "parent-agent-step",
      sessionID: parentSessionID,
      started: started + 100,
    });
    await emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: childSessionID,
          projectID: "test-project",
          directory: "/test",
          parentID: parentSessionID,
          title: "Child investigation",
          version: "1.15.5",
          time: { created: started + 150, updated: started + 150 },
        },
      },
    });

    await sendUserMessage({
      sessionID: childSessionID,
      messageID: childUserMessageID,
      text: "Inspect the child scope",
      started: started + 200,
    });
    await startGeneration({
      id: "child-agent-step",
      sessionID: childSessionID,
      started: started + 300,
    });
    await completeGeneration({
      sessionID: childSessionID,
      userMessageID: childUserMessageID,
      assistantMessageID: childAssistantMessageID,
      started: started + 300,
      completed: started + 600,
      text: "Child result",
    });
    const childFlush = await flushSession(childSessionID);

    await completeGeneration({
      sessionID: parentSessionID,
      userMessageID: parentUserMessageID,
      assistantMessageID: parentAssistantMessageID,
      started: started + 100,
      completed: started + 900,
      text: "Parent result",
    });
    const parentFlush = await flushSession(parentSessionID);
    const spans = [...childFlush.spans, ...parentFlush.spans];

    const parentGeneration = getSessionSpan(
      spans,
      "opencode.generation",
      parentSessionID,
    );
    const childTurn = getSessionSpan(spans, "opencode.turn", childSessionID);
    const childGeneration = getSessionSpan(
      spans,
      "opencode.generation",
      childSessionID,
    );

    expect(childTurn.traceId).toBe(parentGeneration.traceId);
    expect(childTurn.parentSpanId).toBe(parentGeneration.spanId);
    expect(getAttributes(childTurn)).toMatchObject({
      "langfuse.internal.is_app_root": false,
    });
    expect(
      getJsonAttribute(childTurn, "langfuse.observation.metadata"),
    ).toMatchObject({
      parentSessionID,
    });
    expect(childGeneration.traceId).toBe(parentGeneration.traceId);
    expect(childGeneration.parentSpanId).toBe(childTurn.spanId);
    expect(
      getJsonAttribute(parentGeneration, "langfuse.observation.output"),
    ).toEqual([{ role: "assistant", content: "Parent result" }]);
  });

  test("parents each tool to the generation that requested it when lifecycle events arrive out of order", async () => {
    const sessionID = "out-of-order-tool-parenting-session";
    const userMessageID = "out-of-order-tool-parenting-user";
    const started = startedAt;
    const generations = [1, 2, 3].map((index) => ({
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
      assistantMessageID: `out-of-order-tool-parenting-assistant-${index}`,
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
      stepID: `out-of-order-tool-parenting-step-${index}`,
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
      tool: `out-of-order-tool-${index}`,
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
      callID: `out-of-order-tool-parenting-call-${index}`,
    }));

    const executeTool = async (generation: (typeof generations)[number]) => {
      await emitEvent({
        id: `${generation.callID}-called`,
        type: "session.next.tool.called",
        properties: {
          sessionID,
          timestamp: started,
          assistantMessageID: generation.assistantMessageID,
          callID: generation.callID,
          tool: generation.tool,
          input: {},
          provider: { executed: false },
        },
      });
      await hooks["tool.execute.before"]?.(
        { sessionID, callID: generation.callID, tool: generation.tool },
        { args: { generation: generation.assistantMessageID } },
      );
      await hooks["tool.execute.after"]?.(
        {
          sessionID,
          callID: generation.callID,
          tool: generation.tool,
          args: { generation: generation.assistantMessageID },
        },
        { title: generation.tool, output: "ok", metadata: {} },
      );
    };

    await sendUserMessage({
      sessionID,
      messageID: userMessageID,
      text: "Run three tool batches",
      started,
    });

    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: generations[0].assistantMessageID,
      started: started + 100,
    });
    await startGeneration({
      id: generations[0].stepID,
      sessionID,
      assistantMessageID: generations[0].assistantMessageID,
      started: started + 100,
    });
    await executeTool(generations[0]);

    // The next generation and its tool begin before the previous generation's
    // completed message event reaches the plugin.
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: generations[1].assistantMessageID,
      started: started + 200,
    });
    await startGeneration({
      id: generations[1].stepID,
      sessionID,
      assistantMessageID: generations[1].assistantMessageID,
      started: started + 200,
    });
    await executeTool(generations[1]);
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: generations[0].assistantMessageID,
      started: started + 100,
      completed: started + 190,
    });

    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: generations[2].assistantMessageID,
      started: started + 300,
    });
    await startGeneration({
      id: generations[2].stepID,
      sessionID,
      assistantMessageID: generations[2].assistantMessageID,
      started: started + 300,
    });
    await executeTool(generations[2]);
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: generations[1].assistantMessageID,
      started: started + 200,
      completed: started + 290,
    });
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: generations[2].assistantMessageID,
      started: started + 300,
      completed: started + 390,
    });

    const { spans } = await flushSession(sessionID);
    const generationSpans = generations.map((generation) => {
      const span = spans.find((candidate) => {
        if (candidate.name !== "opencode.generation") {
          return false;
        }

        const metadata = getJsonAttribute(
          candidate,
          "langfuse.observation.metadata",
        );
        return (
          typeof metadata === "object" &&
          metadata !== null &&
          "messageID" in metadata &&
          metadata.messageID === generation.assistantMessageID
        );
      });

      expect(span).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Existing violation tracked for incremental cleanup.
      return span!;
    });
    const toolSpans = generations.map((generation) =>
      getSpan(spans, generation.tool),
    );

    expect(toolSpans.map((span) => span.parentSpanId)).toEqual(
      generationSpans.map((span) => span.spanId),
    );
    expect(
      getJsonAttribute(generationSpans[1], "langfuse.observation.input"),
    ).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: generations[0].callID,
            name: generations[0].tool,
            arguments: "{}",
          },
        ],
      },
      {
        role: "tool",
        name: generations[0].tool,
        tool_call_id: generations[0].callID,
        content: "ok",
      },
    ]);
  });

  test("creates a nested tool observation from message parts without execution hooks", async () => {
    const sessionID = "message-part-tool-session";
    const userMessageID = "message-part-tool-user";
    const firstAssistantMessageID = "message-part-tool-assistant-1";
    const secondAssistantMessageID = "message-part-tool-assistant-2";
    const callID = "message-part-tool-call";
    const started = startedAt;
    const toolStarted = started + 200;
    const toolCompleted = started + 350;

    await sendUserMessage({
      sessionID,
      messageID: userMessageID,
      text: "Show recent commits",
      started,
    });
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: firstAssistantMessageID,
      started: started + 100,
    });
    await startGeneration({
      id: "message-part-tool-step-1",
      sessionID,
      assistantMessageID: firstAssistantMessageID,
      started: started + 100,
    });

    const runningPart = {
      id: "message-part-tool-part",
      sessionID,
      messageID: firstAssistantMessageID,
      type: "tool" as const,
      callID,
      tool: "bash",
      state: {
        status: "running" as const,
        input: { command: "git log --oneline -10" },
        title: "Recent commits",
        time: { start: toolStarted },
      },
      metadata: { providerExecuted: true },
    };
    await emitEvent({
      type: "message.part.updated",
      properties: { part: runningPart },
    });
    await emitEvent({
      type: "message.part.updated",
      properties: { part: runningPart },
    });
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          ...runningPart,
          state: {
            status: "completed" as const,
            input: runningPart.state.input,
            title: "Recent commits",
            output: "07f9a68 Fix tool observation parenting",
            metadata: {},
            time: { start: toolStarted, end: toolCompleted },
          },
        },
      },
    });
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: firstAssistantMessageID,
      started: started + 100,
      completed: started + 400,
    });

    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: secondAssistantMessageID,
      started: started + 500,
    });
    await startGeneration({
      id: "message-part-tool-step-2",
      sessionID,
      assistantMessageID: secondAssistantMessageID,
      started: started + 500,
    });
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: secondAssistantMessageID,
      started: started + 500,
      completed: started + 700,
      text: "Here are the recent commits.",
    });

    const { spans } = await flushSession(sessionID);
    const generations = spans.filter(
      (span) => span.name === "opencode.generation",
    );
    const findGeneration = (messageID: string) =>
      generations.find((span) => {
        const metadata = getJsonAttribute(
          span,
          "langfuse.observation.metadata",
        );
        return (
          typeof metadata === "object" &&
          metadata !== null &&
          "messageID" in metadata &&
          metadata.messageID === messageID
        );
      });
    const firstGeneration = findGeneration(firstAssistantMessageID);
    const secondGeneration = findGeneration(secondAssistantMessageID);
    expect(firstGeneration).toBeDefined();
    expect(secondGeneration).toBeDefined();

    const toolSpans = spans.filter((span) => span.name === "bash");
    expect(toolSpans).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Existing violation tracked for incremental cleanup.
    expect(toolSpans[0].parentSpanId).toBe(firstGeneration!.spanId);
    expect(toolSpans[0].startTimeUnixNano).toBe(
      (BigInt(toolStarted) * 1_000_000n).toString(),
    );
    expect(toolSpans[0].endTimeUnixNano).toBe(
      (BigInt(toolCompleted) * 1_000_000n).toString(),
    );
    expect(
      getJsonAttribute(toolSpans[0], "langfuse.observation.input"),
    ).toEqual({ command: "git log --oneline -10" });
    expect(
      getJsonAttribute(toolSpans[0], "langfuse.observation.output"),
    ).toEqual({
      title: "Recent commits",
      output: "07f9a68 Fix tool observation parenting",
    });
    expect(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Existing violation tracked for incremental cleanup.
      getJsonAttribute(secondGeneration!, "langfuse.observation.input"),
    ).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: callID,
            name: "bash",
            arguments: JSON.stringify({ command: "git log --oneline -10" }),
          },
        ],
      },
      {
        role: "tool",
        name: "bash",
        tool_call_id: callID,
        content: "07f9a68 Fix tool observation parenting",
      },
    ]);
  });

  test("exports one resolvable generation when a provider stream error is retried invisibly", async () => {
    // opencode retries provider stream errors inside its session processor and
    // re-streams the same assistant message. The plugin receives no
    // session.error and no lifecycle event for the aborted attempt - only a
    // session.status retry - so the retried message must still settle into
    // exactly one exported generation that subsequent tools can resolve as
    // their parent.
    const sessionID = "stream-error-retry-session";
    const userMessageID = "stream-error-retry-user";
    const assistantMessageID = "stream-error-retry-assistant";
    const nextAssistantMessageID = "stream-error-retry-assistant-2";
    const started = startedAt;
    const completed = started + 7_000;

    await sendUserMessage({
      sessionID,
      messageID: userMessageID,
      text: "Run a command",
      started,
    });

    // Attempt 1: the assistant message starts streaming and emits a partial part.
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID,
      started: started + 100,
    });
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "stream-error-retry-aborted-part",
          sessionID,
          messageID: assistantMessageID,
          type: "text",
          text: "Partial answer cut off by the provider. ",
        },
      },
    });

    // The stream errors mid-call; opencode reports the retry only as a status.
    await emitEvent({
      type: "session.status",
      properties: {
        sessionID,
        status: {
          type: "retry",
          attempt: 1,
          message: "temporary provider failure",
          next: started + 6_500,
        },
      },
    });

    // Attempt 2: the same assistant message re-streams after the backoff gap.
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID,
      started: started + 100,
    });
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "stream-error-retry-recovered-part",
          sessionID,
          messageID: assistantMessageID,
          type: "text",
          text: "Recovered answer",
        },
      },
    });

    // The first tool after the retry window.
    const toolStarted = started + 6_600;
    const toolCompleted = started + 6_700;
    const toolPart = {
      id: "stream-error-retry-tool-part",
      sessionID,
      messageID: assistantMessageID,
      type: "tool" as const,
      callID: "stream-error-retry-call-1",
      tool: "bash",
      state: {
        status: "running" as const,
        input: { command: "echo retry" },
        title: "echo retry",
        time: { start: toolStarted },
      },
    };
    await emitEvent({
      type: "message.part.updated",
      properties: { part: toolPart },
    });
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: toolPart.callID, tool: toolPart.tool },
      { args: toolPart.state.input },
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: toolPart.callID,
        tool: toolPart.tool,
        args: toolPart.state.input,
      },
      { title: "echo retry", output: "retry", metadata: {} },
    );
    await emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          ...toolPart,
          state: {
            status: "completed" as const,
            input: toolPart.state.input,
            title: "echo retry",
            output: "retry",
            metadata: {},
            time: { start: toolStarted, end: toolCompleted },
          },
        },
      },
    });

    // Step finish: usage reaches the message before time.completed does.
    await emitEvent({
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID: userMessageID,
          role: "assistant",
          mode: "build",
          modelID: "test-model",
          providerID: "test-provider",
          path: { cwd: "/test", root: "/test" },
          finish: "stop",
          cost: 0.01,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
          time: { created: started + 100 },
        },
      },
    });

    // The completed message can be re-delivered after the retry.
    const completion = {
      sessionID,
      userMessageID,
      assistantMessageID,
      started: started + 100,
      completed,
    };
    await completeGeneration(completion);
    await completeGeneration(completion);

    // A tool reported only through the execution hooks after the duplicate
    // completion must still parent to an exported span.
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: "stream-error-retry-call-2", tool: "grep" },
      { args: { pattern: "retry" } },
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: "stream-error-retry-call-2",
        tool: "grep",
        args: { pattern: "retry" },
      },
      { title: "grep", output: "1 match", metadata: {} },
    );

    // The next generation proceeds normally.
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID: nextAssistantMessageID,
      started: started + 7_300,
    });
    await completeGeneration({
      sessionID,
      userMessageID,
      assistantMessageID: nextAssistantMessageID,
      started: started + 7_300,
      completed: started + 7_500,
      text: "Done",
    });

    const { spans } = await flushSession(sessionID);

    expect(spans.map((span) => span.name).sort()).toEqual(
      [
        "opencode.turn",
        "opencode.message.user",
        "opencode.generation",
        "opencode.generation",
        "bash",
        "grep",
      ].sort(),
    );

    const spanIds = new Set(spans.map((span) => span.spanId));
    for (const span of spans) {
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- Existing violation; fix separately.
      if (span.parentSpanId) {
        expect(spanIds.has(span.parentSpanId)).toBe(true);
      }
    }

    const retriedGenerations = spans.filter((span) => {
      if (span.name !== "opencode.generation") {
        return false;
      }

      const metadata = getJsonAttribute(span, "langfuse.observation.metadata");
      return (
        typeof metadata === "object" &&
        metadata !== null &&
        "messageID" in metadata &&
        metadata.messageID === assistantMessageID
      );
    });
    expect(retriedGenerations).toHaveLength(1);
    const generation = retriedGenerations[0];

    expect(generation.startTimeUnixNano).toBe(
      (BigInt(started + 100) * 1_000_000n).toString(),
    );
    expect(generation.endTimeUnixNano).toBe(
      (BigInt(completed) * 1_000_000n).toString(),
    );
    expect(generation.status?.code ?? 0).not.toBe(2);
    expect(
      getJsonAttribute(generation, "langfuse.observation.usage_details"),
    ).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cache_read: 3,
      cache_write: 1,
      total: 17,
    });
    expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual(
      [
        expect.objectContaining({
          role: "assistant",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Existing violation tracked for incremental cleanup.
          content: expect.stringContaining("Recovered answer"),
          tool_calls: [
            {
              id: "stream-error-retry-call-1",
              name: "bash",
              arguments: JSON.stringify({ command: "echo retry" }),
            },
          ],
        }),
      ],
    );

    expect(getSpan(spans, "bash").parentSpanId).toBe(generation.spanId);
    expect(getSpan(spans, "grep").parentSpanId).toBe(generation.spanId);
  });

  test("continues tracing when available tool discovery fails", async () => {
    const sessionID = "tool-discovery-failure-session";
    toolListShouldFail = true;

    await sendUserMessage({
      sessionID,
      messageID: "tool-discovery-failure-user",
      text: "Continue without tool definitions",
      started: startedAt,
    });
    await startGeneration({
      id: "tool-discovery-failure-step",
      sessionID,
      started: startedAt + 100,
    });
    await completeGeneration({
      sessionID,
      userMessageID: "tool-discovery-failure-user",
      assistantMessageID: "tool-discovery-failure-assistant",
      started: startedAt + 100,
      completed: startedAt + 500,
      text: "Completed",
    });

    const { spans } = await flushSession(sessionID);
    expect(
      getJsonAttribute(
        getSpan(spans, "opencode.generation"),
        "langfuse.observation.input",
      ),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Continue without tool definitions" }],
      },
    ]);

    toolListShouldFail = false;
    const retrySessionID = "tool-discovery-retry-session";
    await sendUserMessage({
      sessionID: retrySessionID,
      messageID: "tool-discovery-retry-user",
      text: "Retry tool discovery",
      started: startedAt + 1_000,
    });
    await startGeneration({
      id: "tool-discovery-retry-step",
      sessionID: retrySessionID,
      started: startedAt + 1_100,
    });
    await completeGeneration({
      sessionID: retrySessionID,
      userMessageID: "tool-discovery-retry-user",
      assistantMessageID: "tool-discovery-retry-assistant",
      started: startedAt + 1_100,
      completed: startedAt + 1_500,
      text: "Completed with tools",
    });

    const retry = await flushSession(retrySessionID);
    expect(toolListCalls).toBe(2);
    expect(
      getJsonAttribute(
        getSpan(retry.spans, "opencode.generation"),
        "langfuse.observation.input",
      ),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Retry tool discovery" }],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Existing violation tracked for incremental cleanup.
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "read" }),
          expect.objectContaining({ name: "webfetch" }),
        ]),
      },
    ]);
  });

  test("preserves step metadata when the assistant message arrives later", async () => {
    const sessionID = "late-assistant-message-session";
    const userMessageID = "late-assistant-message-user";
    const assistantMessageID = "late-assistant-message-assistant";
    const started = startedAt;

    await sendUserMessage({
      sessionID,
      messageID: userMessageID,
      text: "Keep the generation metadata",
      started,
    });
    await startGeneration({
      id: "late-assistant-message-step",
      sessionID,
      assistantMessageID,
      started: started + 100,
      snapshot: "snapshot-1",
    });
    await startAssistantMessage({
      sessionID,
      userMessageID,
      assistantMessageID,
      started: started + 100,
    });

    const { spans } = await flushSession(sessionID);
    const generation = getSpan(spans, "opencode.generation");

    expect(
      getJsonAttribute(generation, "langfuse.observation.metadata"),
    ).toEqual({
      agent: "build",
      providerID: "test-provider",
      variant: "high",
      snapshot: "snapshot-1",
    });
  });

  test("exports a failed generation as an error span", async () => {
    const sessionID = "failed-session";
    const started = startedAt;

    await sendUserMessage({
      sessionID,
      messageID: "failed-user",
      text: "Trigger a failure",
      started,
    });
    await startGeneration({
      id: "failed-step-start",
      sessionID,
      started: started + 100,
    });
    await emitEvent({
      id: "failed-step",
      type: "session.next.step.failed",
      properties: {
        sessionID,
        timestamp: started + 500,
        error: { message: "Model unavailable" },
      },
    });

    const { spans } = await flushSession(sessionID);
    const generation = getSpan(spans, "opencode.generation");

    expect(generation.status).toMatchObject({
      code: 2,
      message: "Model unavailable",
    });
    expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual(
      {
        error: { message: "Model unavailable" },
      },
    );
    expect(generation.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
    );
  });

  test("suppresses generation completion after a session abort", async () => {
    const sessionID = "aborted-session";
    const started = startedAt;

    await sendUserMessage({
      sessionID,
      messageID: "aborted-user",
      text: "Stop this request",
      started,
    });
    await startGeneration({
      id: "aborted-step",
      sessionID,
      started: started + 100,
    });
    await emitEvent({
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "MessageAbortedError", message: "User cancelled" },
      },
    });
    await completeGeneration({
      sessionID,
      userMessageID: "aborted-user",
      assistantMessageID: "aborted-assistant",
      started: started + 100,
      completed: started + 500,
      text: "This output must not be traced",
    });

    const { spans } = await flushSession(sessionID);
    const generations = spans.filter(
      (span) => span.name === "opencode.generation",
    );

    expect(generations).toHaveLength(1);
    const attributes = getAttributes(generations[0]);
    expect(attributes).not.toHaveProperty("langfuse.observation.output");
    expect(attributes).not.toHaveProperty("langfuse.observation.usage_details");
    expect(attributes).not.toHaveProperty("langfuse.observation.cost_details");
    expect(
      getJsonAttribute(generations[0], "langfuse.observation.metadata"),
    ).toEqual({
      agent: "build",
      providerID: "test-provider",
      variant: "high",
    });
    expect(generations[0].status?.code ?? 0).not.toBe(2);
  });

  test("exports a generation without a step-start event", async () => {
    const sessionID = "fallback-session";
    const started = startedAt;

    await sendUserMessage({
      sessionID,
      messageID: "fallback-user",
      text: "Complete without a step event",
      started,
    });
    await completeGeneration({
      sessionID,
      userMessageID: "fallback-user",
      assistantMessageID: "fallback-assistant",
      started: started + 100,
      completed: started + 500,
      text: "Fallback output",
    });

    const { spans } = await flushSession(sessionID);
    const generation = getSpan(spans, "opencode.generation");
    const turn = getSpan(spans, "opencode.turn");

    expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual(
      [{ role: "assistant", content: "Fallback output" }],
    );
    expect(generation.traceId).toBe(turn.traceId);
    expect(generation.parentSpanId).toBe(turn.spanId);
  });

  test("deduplicates repeated OpenCode events", async () => {
    const sessionID = "duplicate-session";
    const started = startedAt;
    const userInput = {
      sessionID,
      messageID: "duplicate-user",
      text: "Do this once",
      started,
    };

    await sendUserMessage(userInput);
    await sendUserMessage(userInput);
    await startGeneration({
      id: "duplicate-step",
      sessionID,
      started: started + 100,
    });

    const retryEvent = {
      id: "duplicate-retry",
      type: "session.next.retried",
      properties: {
        sessionID,
        timestamp: started + 200,
        attempt: 2,
        error: { message: "temporary failure" },
      },
    } satisfies SessionNextEvent;
    await emitEvent(retryEvent);
    await emitEvent(retryEvent);

    const reasoningEvent = {
      id: "duplicate-reasoning-event",
      type: "session.next.reasoning.ended",
      properties: {
        sessionID,
        timestamp: started + 250,
        assistantMessageID: "duplicate-assistant",
        reasoningID: "duplicate-reasoning",
        text: "Think once",
      },
    } satisfies SessionNextEvent;
    await emitEvent(reasoningEvent);
    await emitEvent({ ...reasoningEvent, id: "duplicate-reasoning-event-2" });

    const completion = {
      sessionID,
      userMessageID: "duplicate-user",
      assistantMessageID: "duplicate-assistant",
      started: started + 100,
      completed: started + 500,
      text: "One output",
    };
    await completeGeneration(completion);
    await completeGeneration(completion);

    const { spans } = await flushSession(sessionID);

    expect(spans.map((span) => span.name).sort()).toEqual(
      [
        "opencode.turn",
        "opencode.message.user",
        "opencode.generation",
        "opencode.generation.retry",
      ].sort(),
    );

    expect(
      getJsonAttribute(
        getSpan(spans, "opencode.generation"),
        "langfuse.observation.output",
      ),
    ).toEqual([
      {
        role: "assistant",
        content: "One output",
        thinking: [{ type: "thinking", content: "Think once" }],
      },
    ]);
  });

  test("does not reject hooks when the collector returns an error", async () => {
    collectorStatus = 503;

    await sendUserMessage({
      sessionID: "collector-error-session",
      messageID: "collector-error-user",
      text: "Export despite the collector error",
      started: startedAt,
    });

    await expect(
      emitEvent({
        type: "session.idle",
        properties: { sessionID: "collector-error-session" },
      }),
    ).resolves.toBeUndefined();
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (request) =>
          request.method === "POST" &&
          request.url === "/api/public/otel/v1/traces",
      ),
    ).toBe(true);
    expect(collectorErrors).toEqual([]);
  });

  test("does not reject hooks when the collector is unreachable", async () => {
    await disposeHooks();

    const originalExporterTimeout =
      process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "100";
    const unavailableServer = createServer();
    // eslint-disable-next-line @typescript-eslint/strict-void-return -- Existing violation; fix separately.
    unavailableServer.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      unavailableServer.once("error", reject);
      unavailableServer.listen(0, "127.0.0.1", resolve);
    });
    const address = unavailableServer.address();
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- Existing violation; fix separately.
    if (!address || typeof address === "string") {
      throw new Error("Expected the unavailable collector to use a TCP port");
    }
    hooksDisposed = false;
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Existing violation tracked for incremental cleanup.
    hooks = await createHooks(`http://127.0.0.1:${address.port}`);
    try {
      await sendUserMessage({
        sessionID: "unreachable-collector-session",
        messageID: "unreachable-collector-user",
        text: "Export without a collector",
        started: startedAt,
      });

      await expect(
        emitEvent({
          type: "session.idle",
          properties: { sessionID: "unreachable-collector-session" },
        }),
      ).resolves.toBeUndefined();
      expect(requests).toEqual([]);
    } finally {
      try {
        await disposeHooks();
        await new Promise<void>((resolve, reject) =>
          // eslint-disable-next-line @typescript-eslint/strict-void-return -- Existing violation; fix separately.
          unavailableServer.close((error) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Existing violation tracked for incremental cleanup.
            error ? reject(error) : resolve();
          }),
        );
      } finally {
        if (originalExporterTimeout === undefined) {
          delete process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT;
        } else {
          process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT =
            originalExporterTimeout;
        }
      }
    }
  }, 10_000);

  test("resolves service.name from config, OTEL environment variables, then default", async () => {
    const originalValues = {
      OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
      OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
      LANGFUSE_SERVICE_NAME: process.env.LANGFUSE_SERVICE_NAME,
    };

    const recreateHooks = async () => {
      await disposeHooks();
      hooksDisposed = false;
      hooks = await createHooks(collectorBaseUrl);
    };

    const getSessionResourceAttributes = async (sessionID: string) => {
      await sendUserMessage({
        sessionID,
        messageID: `${sessionID}-user`,
        text: "Trace for resource attributes",
        started: startedAt,
      });
      const { requests: sessionRequests } = await flushSession(sessionID);
      expect(sessionRequests.length).toBeGreaterThan(0);
      return sessionRequests.map(getResourceAttributes);
    };

    try {
      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      delete process.env.LANGFUSE_SERVICE_NAME;
      await recreateHooks();

      for (const attributes of await getSessionResourceAttributes(
        "resource-default-session",
      )) {
        expect(attributes["service.name"]).toMatch(/^unknown_service/);
        expect(attributes["deployment.environment"]).toBeUndefined();
      }

      process.env.OTEL_SERVICE_NAME = "env-service";
      process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=ci";
      await recreateHooks();

      for (const attributes of await getSessionResourceAttributes(
        "resource-env-session",
      )) {
        expect(attributes["service.name"]).toBe("env-service");
        expect(attributes["deployment.environment"]).toBe("ci");
      }

      process.env.LANGFUSE_SERVICE_NAME = "config-service";
      await recreateHooks();

      for (const attributes of await getSessionResourceAttributes(
        "resource-config-session",
      )) {
        expect(attributes["service.name"]).toBe("config-service");
        expect(attributes["deployment.environment"]).toBe("ci");
      }
    } finally {
      for (const [name, value] of Object.entries(originalValues)) {
        if (value === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Existing violation tracked for incremental cleanup.
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  }, 15_000);

  test("can be disposed repeatedly", async () => {
    expect(hooks.dispose).toBeDefined();
    await hooks.dispose?.();

    await expect(hooks.dispose?.()).resolves.toBeUndefined();
    hooksDisposed = true;
    trace.disable();
  });
});
