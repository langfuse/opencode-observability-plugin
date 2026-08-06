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

interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number;
}

interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: OtlpValue }>;
  status?: { code?: number; message?: string };
  events?: Array<{ name: string }>;
}

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: OtlpSpan[] }>;
    }>;
  };
}

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
  started: number;
  snapshot?: string;
}) => {
  await emitEvent({
    id: input.id,
    type: "session.next.step.started",
    properties: {
      sessionID: input.sessionID,
      timestamp: input.started,
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

const completeGeneration = async (input: {
  sessionID: string;
  userMessageID: string;
  assistantMessageID: string;
  started: number;
  completed: number;
  text?: string;
}) => {
  if (input.text) {
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

    request.on("error", (error) => collectorErrors.push(error));
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test collector to listen on a TCP port");
  }

  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  collectorBaseUrl = `http://127.0.0.1:${address.port}`;
  process.env.LANGFUSE_BASE_URL = collectorBaseUrl;
  process.env.LANGFUSE_ENVIRONMENT = "integration-test";
  process.env.LANGFUSE_USER_ID = "test-user";
  delete process.env.LANGFUSE_BASEURL;

  ({ default: plugin } = await import("../../dist/index.js"));
});

beforeEach(async () => {
  requests.length = 0;
  collectorErrors.length = 0;
  collectorStatus = 200;
  hooksDisposed = false;
  hooks = await createHooks(collectorBaseUrl);
});

afterEach(async () => {
  await disposeHooks();
});

afterAll(async () => {
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

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
    const failedToolStarted = Date.now();
    const failedToolEnded = failedToolStarted + 5_000;
    await hooks["tool.execute.before"]?.(
      { sessionID, callID: "timed-out-webfetch", tool: "webfetch" },
      { args: { url: "https://example.com", timeout: 5 } },
    );
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
        "opencode.generation.reasoning",
        "opencode.generation.reasoning",
        "read",
        "webfetch",
        "opencode.generation.retry",
        "opencode.generation.compaction",
      ].sort(),
    );

    const generation = getSpan(spans, "opencode.generation");

    const tool = getSpan(spans, "read");
    expect(getJsonAttribute(tool, "langfuse.observation.input")).toEqual({
      path: "README.md",
    });
    expect(getJsonAttribute(tool, "langfuse.observation.output")).toEqual({
      title: "README.md",
      output: "# Project",
    });
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

    const reasoningSpans = spans.filter((span) => {
      if (span.name !== "opencode.generation.reasoning") {
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
    expect(reasoningSpans).toHaveLength(2);
    for (const reasoning of reasoningSpans) {
      expect(reasoning.parentSpanId).toBe(generation.spanId);
    }
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
      {
        text: "Fallback output",
      },
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
        "opencode.generation.reasoning",
      ].sort(),
    );
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
    unavailableServer.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      unavailableServer.once("error", reject);
      unavailableServer.listen(0, "127.0.0.1", resolve);
    });
    const address = unavailableServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the unavailable collector to use a TCP port");
    }
    hooksDisposed = false;
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
          unavailableServer.close((error) =>
            error ? reject(error) : resolve(),
          ),
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

  test("can be disposed repeatedly", async () => {
    expect(hooks.dispose).toBeDefined();
    await hooks.dispose?.();

    await expect(hooks.dispose?.()).resolves.toBeUndefined();
    hooksDisposed = true;
    trace.disable();
  });
});
