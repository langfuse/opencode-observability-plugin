import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

import CombinedPlugin from "@langfuse/opencode-observability-plugin";
import LangfusePlugin from "@langfuse/opencode-observability-plugin/v2";
import { Agent, Model, Provider } from "@opencode/plugin";
import type { Hooks } from "@opencode/plugin/promise/registration";
import type { SessionHooks as SessionHookInputs } from "@opencode/plugin/promise/session";
import { CallID, Error as ToolError } from "@opencode/plugin/promise/tool";
import { trace } from "@opentelemetry/api";
import { Schema } from "effect";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import SourcePlugin from "../../src/v2.js";
import { PLUGIN_VERSION } from "../../src/version.js";

type PluginContext = Parameters<typeof LangfusePlugin.setup>[0];
type ToolHook = Parameters<PluginContext["tool"]["hook"]>[1];
type ToolHookInputs =
  PluginContext["tool"]["hook"] extends Hooks<infer Inputs> ? Inputs : never;

// These SDK IDs are string brands with no additional runtime constraints.
const SessionIDSchema = Schema.declare(
  (value): value is Parameters<ToolHook>[0]["sessionID"] =>
    typeof value === "string",
);
const MessageIDSchema = Schema.declare(
  (value): value is Parameters<ToolHook>[0]["messageID"] =>
    typeof value === "string",
);

const SpanSchema = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
    }),
  ),
  status: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
});
const PayloadSchema = Schema.parseJson(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({ spans: Schema.Array(SpanSchema) }),
        ),
      }),
    ),
  }),
);

const getJsonAttribute = (span: typeof SpanSchema.Type, key: string) => {
  const value = span.attributes.find((attribute) => attribute.key === key)
    ?.value.stringValue;
  if (value === undefined) {
    throw new Error(`Expected ${span.name} attribute ${key}`);
  }
  return Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(value);
};

function createPluginContext(input: {
  sessionHook: PluginContext["session"]["hook"];
  toolHook: PluginContext["tool"]["hook"];
  subscribe: PluginContext["event"]["subscribe"];
  storage?: PluginContext["storage"];
  getSession?: PluginContext["session"]["get"];
}) {
  const stored = new Map<
    string,
    Parameters<PluginContext["storage"]["set"]>[1]
  >();
  const unexpectedApi = () => {
    throw new Error("The plugin used an unsupported mock host capability");
  };
  return {
    app: { name: "opencode", version: "2.0.4", channel: "stable" },
    session: {
      hook: input.sessionHook,
      create: unexpectedApi,
      get: input.getSession ?? unexpectedApi,
      switchAgent: unexpectedApi,
      switchModel: unexpectedApi,
      prompt: unexpectedApi,
      generate: unexpectedApi,
      command: unexpectedApi,
      synthetic: unexpectedApi,
      interrupt: unexpectedApi,
      update: unexpectedApi,
      move: unexpectedApi,
      wait: unexpectedApi,
      context: unexpectedApi,
    },
    tool: {
      hook: input.toolHook,
      transform: unexpectedApi,
      reload: unexpectedApi,
    },
    event: { subscribe: input.subscribe },
    get location() {
      return unexpectedApi();
    },
    get options() {
      return unexpectedApi();
    },
    get agent() {
      return unexpectedApi();
    },
    get aisdk() {
      return unexpectedApi();
    },
    get command() {
      return unexpectedApi();
    },
    get experimental() {
      return unexpectedApi();
    },
    get integration() {
      return unexpectedApi();
    },
    get mcp() {
      return unexpectedApi();
    },
    get model() {
      return unexpectedApi();
    },
    get generate() {
      return unexpectedApi();
    },
    get permission() {
      return unexpectedApi();
    },
    get plugin() {
      return unexpectedApi();
    },
    get provider() {
      return unexpectedApi();
    },
    get reference() {
      return unexpectedApi();
    },
    get rpc() {
      return unexpectedApi();
    },
    get shell() {
      return unexpectedApi();
    },
    get skill() {
      return unexpectedApi();
    },
    storage: input.storage ?? {
      get: (key) => Promise.resolve(stored.get(key)),
      set: (key, value) => {
        stored.set(key, structuredClone(value));
        return Promise.resolve();
      },
      remove: (key) => {
        stored.delete(key);
        return Promise.resolve();
      },
      scan: ({ prefix, after }) =>
        Promise.resolve({
          entries: [...stored]
            .filter(
              ([key]) =>
                key.startsWith(prefix) && (after === undefined || key > after),
            )
            .map(([key, value]) => ({ key, value })),
        }),
    },
    get vcs() {
      return unexpectedApi();
    },
    get websearch() {
      return unexpectedApi();
    },
    get worktree() {
      return unexpectedApi();
    },
  } satisfies PluginContext;
}

async function createCollector() {
  const spans: (typeof SpanSchema.Type)[] = [];
  const collectorErrors: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("error", (error) => {
      collectorErrors.push(error);
    });
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const decodedBody =
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(body)
            : body;
        const payload = Schema.decodeUnknownSync(PayloadSchema)(
          decodedBody.toString("utf8"),
        );
        spans.push(
          ...payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      } catch (error) {
        collectorErrors.push(error);
        response.writeHead(400);
        response.end("{}");
      }
    });
  });
  onTestFinished(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      trace.disable();
      globalThis.langfuseOpencodeRuntimeState = undefined;
      vi.unstubAllEnvs();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP collector address");
  }
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
  vi.stubEnv(
    "LANGFUSE_BASE_URL",
    `http://127.0.0.1:${address.port.toString()}`,
  );
  vi.stubEnv("LANGFUSE_ENVIRONMENT", "integration-test");

  return { spans, collectorErrors };
}

const createHookRegistry = <Inputs extends object>() => {
  const hooks: {
    [Name in keyof Inputs]?: (input: Inputs[Name]) => Promise<void> | void;
  } = {};
  return {
    register: <Name extends keyof Inputs>(
      name: Name,
      handler: (input: Inputs[Name]) => Promise<void> | void,
    ) => {
      hooks[name] = handler;
      return Promise.resolve({
        dispose: () => {
          hooks[name] = undefined;
          return Promise.resolve();
        },
      });
    },
    run: async <Name extends keyof Inputs>(name: Name, input: Inputs[Name]) => {
      const handler = hooks[name];
      if (!handler) {
        throw new Error(`Expected hook ${String(name)}`);
      }
      await handler(input);
    },
  };
};

test("restores durable parents for in-flight tools, later tools, and generation continuations after replacement", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const admitted = Promise.withResolvers<undefined>();
  const firstEventsFinished = Promise.withResolvers<undefined>();
  const continueExecution = Promise.withResolvers<undefined>();
  const secondEventsFinished = Promise.withResolvers<undefined>();
  const sessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("durable-session");
  const messageID =
    Schema.decodeUnknownSync(MessageIDSchema)("durable-generation");
  const followupID =
    Schema.decodeUnknownSync(MessageIDSchema)("durable-followup");
  const model = {
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test-provider"),
  };
  const agent = Agent.ID.make("build");
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  let instance = 0;
  const context = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: toolHooks.register,
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        const first = instance++ === 0;
        await (first ? admitted.promise : continueExecution.promise);
        const assistantMessageID = first ? messageID : followupID;
        yield {
          type: "session.step.started",
          id: `start-${assistantMessageID}`,
          created: Date.now(),
          durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
          data: { sessionID, assistantMessageID, agent, model },
        };
        yield {
          type: "session.step.ended",
          id: `end-${assistantMessageID}`,
          created: Date.now(),
          durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
          data: {
            sessionID,
            assistantMessageID,
            finish: "tool-calls",
            cost: 0,
            tokens,
          },
        };
        if (!first) {
          yield {
            type: "session.deleted",
            id: "deleted",
            created: Date.now(),
            durable: { aggregateID: sessionID, seq: 3, version: 2 as const },
            data: { sessionID },
          };
        }
        (first ? firstEventsFinished : secondEventsFinished).resolve(undefined);
      },
    }),
  });
  const firstCleanup = await LangfusePlugin.setup(context);
  const previousVersionKey = `langfuse.observability/tracing/previous-version/${sessionID}/turn`;
  const otherPluginKey = `other-plugin/tracing/${PLUGIN_VERSION}/${sessionID}/turn`;
  await context.storage.set(otherPluginKey, "other-plugin-context");
  await context.storage.set(previousVersionKey, "previous-version-context");
  await sessionHooks.run("prompt", {
    sessionID,
    messageID: Schema.decodeUnknownSync(MessageIDSchema)("durable-user"),
    prompt: { text: "Run tools" },
    delivery: "steer",
  });
  admitted.resolve(undefined);
  await firstEventsFinished.promise;
  const call = {
    id: CallID.make("durable-in-flight"),
    messageID,
    sessionID,
    agent,
    tool: "shell",
    input: { command: "pwd" },
  };
  await toolHooks.run("execute.before", call);
  await firstCleanup?.();

  expect(
    typeof (await context.storage.get(
      `langfuse.observability/tracing/${PLUGIN_VERSION}/${sessionID}/generation/${messageID}`,
    )),
  ).toBe("string");
  // Disposal cleared the shared client's parent maps, so restoration must use storage.
  const secondCleanup = await LangfusePlugin.setup(context);
  await toolHooks.run("execute.after", {
    ...call,
    status: "completed",
    result: { content: "/project" },
  });
  const later = { ...call, id: CallID.make("durable-later") };
  await toolHooks.run("execute.before", later);
  await toolHooks.run("execute.after", {
    ...later,
    status: "error",
    error: new ToolError({ message: "failed" }),
  });
  continueExecution.resolve(undefined);
  await secondEventsFinished.promise;
  await secondCleanup?.();

  expect(collectorErrors).toEqual([]);
  const generations = spans.filter(
    (span) => span.name === "opencode.generation",
  );
  expect(generations).toHaveLength(2);
  const turn = spans.find((span) => span.name === "opencode.turn");
  expect(turn).toBeDefined();
  for (const generation of generations) {
    expect(generation.parentSpanId).toBe(turn?.spanId);
    expect(generation.traceId).toBe(turn?.traceId);
  }
  const completedTools = spans.filter(
    (span) =>
      span.name === "shell" &&
      span.attributes.some(
        (attribute) => attribute.key === "langfuse.observation.output",
      ),
  );
  expect(completedTools).toHaveLength(2);
  for (const tool of completedTools) {
    expect(tool.traceId).toBe(generations[0].traceId);
    expect(tool.parentSpanId).toBe(generations[0].spanId);
  }
  expect(
    await context.storage.scan({
      prefix: `langfuse.observability/tracing/${PLUGIN_VERSION}/${sessionID}/`,
    }),
  ).toEqual({ entries: [] });
  expect(await context.storage.get(previousVersionKey)).toBe(
    "previous-version-context",
  );
  expect(await context.storage.get(otherPluginKey)).toBe(
    "other-plugin-context",
  );
});

test.each([
  "invalid-json",
  JSON.stringify({
    generation: { traceId: "invalid", spanId: "invalid", traceFlags: 1 },
  }),
  { generation: "legacy-unencoded-context" },
])("ignores malformed stored parent contexts: %j", async (stored) => {
  const { spans, collectorErrors } = await createCollector();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  onTestFinished(() => {
    warning.mockRestore();
  });
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const context = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: toolHooks.register,
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield* [];
      },
    }),
  });
  const sessionID = Schema.decodeUnknownSync(SessionIDSchema)(
    "invalid-context-session",
  );
  const messageID = Schema.decodeUnknownSync(MessageIDSchema)(
    "invalid-context-message",
  );
  await context.storage.set(
    `langfuse.observability/tracing/${PLUGIN_VERSION}/${sessionID}/generation/${messageID}`,
    stored,
  );
  const cleanup = await LangfusePlugin.setup(context);
  const call = {
    id: CallID.make("invalid-context-call"),
    sessionID,
    messageID,
    agent: Agent.ID.make("build"),
    tool: "shell",
    input: { command: "pwd" },
  };
  await toolHooks.run("execute.before", call);
  await toolHooks.run("execute.after", {
    ...call,
    status: "completed",
    result: { content: "/project" },
  });
  await cleanup?.();
  expect(warning).toHaveBeenCalled();
  expect(collectorErrors).toEqual([]);
  const tools = spans.filter((span) => span.name === "shell");
  expect(tools).toHaveLength(1);
  expect(tools[0].parentSpanId).toBeUndefined();
  expect(
    getJsonAttribute(tools[0], "langfuse.observation.output"),
  ).toMatchObject({ content: "/project" });
});

test("keeps V2 tool calls and observations with their calling generations despite late and duplicate hooks", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const eventsFinished = Promise.withResolvers<undefined>();

  const sessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("v2-parallel-tools");
  const assistantMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-tool-generation");
  const followupMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-followup");
  const followupCallID = CallID.make("v2-followup-call");
  const agent = Agent.ID.make("build");
  const model = {
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test-provider"),
  };
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const calls = [
    {
      id: CallID.make("v2-call-first"),
      path: "first.txt",
      content: "First\nresponse",
      status: "completed" as const,
    },
    {
      id: CallID.make("v2-call-second"),
      path: "second.txt",
      content: "Second\n\nresponse",
      status: "completed" as const,
    },
    {
      id: CallID.make("v2-call-missing"),
      path: "missing.txt",
      content: "ENOENT: missing.txt",
      status: "error" as const,
    },
  ];
  const results = calls.map((call) => ({
    role: "tool",
    name: "read",
    tool_call_id: call.id,
    content: call.content,
  }));
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Read three files" }],
    },
    {
      role: "assistant" as const,
      content: [
        { type: "reasoning" as const, text: "Need the files" },
        { type: "text" as const, text: "Reading first. " },
        { type: "text" as const, text: "Reading the rest." },
        ...calls.map((call) => ({
          type: "tool-call" as const,
          id: call.id,
          name: "read",
          input: { path: call.path },
          providerExecuted: false,
        })),
      ],
    },
    ...calls.map((call) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          id: call.id,
          name: "read",
          result: {
            type: (
              {
                completed: "text",
                error: "error",
              } as const satisfies Record<
                (typeof calls)[number]["status"],
                "text" | "error"
              >
            )[call.status],
            value: call.content,
          },
        },
      ],
    })),
  ] satisfies SessionHookInputs["context"]["messages"];
  const exportedMessages = [
    messages[0],
    {
      role: "assistant",
      content: [
        ...messages[1].content.slice(0, 3),
        ...calls.map((call) => ({
          type: "tool-call",
          toolCallId: call.id,
          toolName: "read",
          input: { path: call.path },
          providerExecuted: false,
        })),
      ],
    },
    ...calls.map((call) => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.id,
          toolName: "read",
          output: {
            type: call.status === "error" ? "error-text" : "text",
            value: call.content,
          },
          ...(call.status === "error" ? { isError: true } : {}),
        },
      ],
    })),
  ];
  const contextInput = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: toolHooks.register,
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        try {
          await sessionHooks.run("prompt", {
            sessionID,
            messageID: Schema.decodeUnknownSync(MessageIDSchema)("v2-user"),
            prompt: { text: "Read three files" },
            delivery: "steer",
          });
          yield {
            id: "v2-tools-started",
            durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: { sessionID, assistantMessageID, agent, model },
          };
          yield {
            id: "v2-reasoning-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.reasoning.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              ordinal: 0,
              text: "Need the files",
            },
          };
          for (const text of ["Reading first. ", "Reading the rest."]) {
            yield {
              id: `v2-text-ended-${text}`,
              durable: {
                aggregateID: sessionID,
                seq: 3,
                version: 1 as const,
              },
              type: "session.text.ended",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                ordinal: text === "Reading first. " ? 1 : 2,
                text,
              },
            };
          }
          for (const call of calls) {
            yield {
              id: `v2-input-started-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 4,
                version: 1 as const,
              },
              type: "session.tool.input.started",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                name: "read",
              },
            };
            yield {
              id: `v2-called-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 5,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                input: { path: call.path },
                executed: false,
              },
            };
            if (call.status === "error") {
              continue;
            }
            await toolHooks.run("execute.before", {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            });
          }
          // Same names and reversed completions must still match by call ID.
          for (const call of [...calls].reverse()) {
            if (call.status === "error") {
              continue;
            }
            const input = {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            };
            const result = {
              ...input,
              status: "completed",
              result: {
                content:
                  call.id === "v2-call-second"
                    ? [
                        { type: "text", text: "Second" },
                        { type: "text", text: "response" },
                      ]
                    : call.content,
              },
            } satisfies Parameters<ToolHook>[0];
            await toolHooks.run("execute.after", result);
            await toolHooks.run("execute.after", result);
          }
          yield {
            id: "v2-tools-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              finish: "tool-calls",
              cost: 0,
              tokens,
            },
          };
          await sessionHooks.run("context", {
            sessionID,
            agent,
            model,
            system: [],
            messages,
            options: {},
            tools: {},
          });
          yield {
            id: "v2-followup-started",
            durable: { aggregateID: sessionID, seq: 3, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              agent,
              model,
            },
          };
          // A late first-generation hook must not attach to the active followup.
          for (const call of calls.filter((call) => call.status === "error")) {
            const input = {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            };
            await toolHooks.run("execute.before", input);
            await toolHooks.run("execute.before", input);
            const result = {
              ...input,
              status: "error" as const,
              error: new ToolError({ message: call.content }),
            };
            await toolHooks.run("execute.after", result);
            await toolHooks.run("execute.after", result);
            yield {
              id: `v2-late-called-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 6,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                input: { path: call.path },
                executed: false,
              },
            };
          }
          yield {
            id: "v2-followup-input-started",
            durable: { aggregateID: sessionID, seq: 7, version: 1 as const },
            type: "session.tool.input.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              id: followupCallID,
              name: "bash",
            },
          };
          for (let repeat = 0; repeat < 2; repeat++) {
            yield {
              id: "v2-followup-called",
              durable: {
                aggregateID: sessionID,
                seq: 8,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID: followupMessageID,
                id: followupCallID,
                input: { command: "pwd" },
                executed: false,
              },
            };
          }
          yield {
            id: "v2-followup-ended",
            durable: { aggregateID: sessionID, seq: 4, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              finish: "tool-calls",
              cost: 0,
              tokens,
            },
          };
          const followupToolInput = {
            sessionID,
            messageID: followupMessageID,
            agent,
            tool: "bash",
            id: followupCallID,
            input: { command: "pwd" },
          };
          await toolHooks.run("execute.before", followupToolInput);
          await toolHooks.run("execute.before", followupToolInput);
          const followupToolResult = {
            ...followupToolInput,
            status: "completed" as const,
            result: { content: "/project" },
          };
          await toolHooks.run("execute.after", followupToolResult);
          await toolHooks.run("execute.after", followupToolResult);
          yield {
            id: "v2-execution-succeeded",
            durable: { aggregateID: sessionID, seq: 5, version: 1 as const },
            type: "session.execution.succeeded",
            created: Date.now(),
            data: { sessionID },
          };
        } finally {
          eventsFinished.resolve(undefined);
        }
      },
    }),
  });
  // This mock host does not prove compatibility with a running OpenCode server.
  const cleanup = await LangfusePlugin.setup(contextInput);
  if (!cleanup) {
    throw new Error("Expected plugin cleanup");
  }
  onTestFinished(cleanup);
  await eventsFinished.promise;

  expect(collectorErrors).toEqual([]);
  const tools = spans.filter((span) => span.name === "read");
  expect(tools).toHaveLength(calls.length);
  const generations = spans.filter(
    (span) => span.name === "opencode.generation",
  );
  expect(generations).toHaveLength(2);
  const generation = generations.find((span) => {
    const metadata = getJsonAttribute(span, "langfuse.observation.metadata");
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      "messageID" in metadata &&
      metadata.messageID === assistantMessageID
    );
  });
  const followup = generations.find((span) => span !== generation);
  if (!generation || !followup) {
    throw new Error("Expected both generations");
  }
  expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual([
    exportedMessages[1],
  ]);
  expect(
    getJsonAttribute(followup, "langfuse.observation.metadata"),
  ).toMatchObject({ messageID: followupMessageID });
  expect(getJsonAttribute(followup, "langfuse.observation.output")).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: followupCallID,
          toolName: "bash",
          input: { command: "pwd" },
          providerExecuted: false,
        },
      ],
    },
  ]);
  const followupTools = spans.filter((span) => span.name === "bash");
  expect(followupTools).toHaveLength(1);
  expect(followupTools[0].parentSpanId).toBe(followup.spanId);
  expect(
    getJsonAttribute(followupTools[0], "langfuse.observation.output"),
  ).toEqual({
    role: "tool",
    name: "bash",
    tool_call_id: followupCallID,
    content: "/project",
  });
  for (const [index, call] of calls.entries()) {
    const tool = tools.find((span) => {
      const output = getJsonAttribute(span, "langfuse.observation.output");
      return (
        typeof output === "object" &&
        output !== null &&
        "tool_call_id" in output &&
        output.tool_call_id === call.id
      );
    });
    if (!tool) {
      throw new Error(`Expected response for ${call.id}`);
    }
    expect(getJsonAttribute(tool, "langfuse.observation.output")).toEqual(
      results[index],
    );
    expect(tool.parentSpanId).toBe(generation.spanId);
    expect(getJsonAttribute(tool, "langfuse.observation.metadata")).toEqual({
      callID: call.id,
      tool: "read",
    });
    if (call.status === "error") {
      expect(tool.status).toEqual({ code: 2, message: call.content });
    }
  }
  expect(getJsonAttribute(followup, "langfuse.observation.input")).toEqual({
    system: [],
    messages: exportedMessages,
    tools: [],
  });
});

test("omits V2 cost_details when OpenCode reports zero cost", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionID = Schema.decodeUnknownSync(SessionIDSchema)("v2-zero-cost");
  const assistantMessageID = Schema.decodeUnknownSync(MessageIDSchema)(
    "v2-zero-cost-assistant",
  );
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 2,
    cache: { read: 3, write: 1 },
  };
  const eventsFinished = Promise.withResolvers<undefined>();
  const registration = { dispose: () => Promise.resolve() };
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const context = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: () => Promise.resolve(registration),
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        try {
          await sessionHooks.run("prompt", {
            sessionID,
            messageID:
              Schema.decodeUnknownSync(MessageIDSchema)("v2-zero-cost-user"),
            prompt: {
              text: "Use a custom provider without OpenCode cost config",
            },
            delivery: "steer",
          });
          yield {
            id: "v2-zero-cost-started",
            durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              agent: Agent.ID.make("build"),
              model: {
                id: Model.ID.make("custom-model"),
                providerID: Provider.ID.make("custom-provider"),
              },
            },
          };
          yield {
            id: "v2-zero-cost-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens,
            },
          };
          yield {
            id: "v2-zero-cost-succeeded",
            durable: { aggregateID: sessionID, seq: 3, version: 1 as const },
            type: "session.execution.succeeded",
            created: Date.now(),
            data: { sessionID },
          };
        } finally {
          eventsFinished.resolve(undefined);
        }
      },
    }),
  });

  const cleanup = await LangfusePlugin.setup(context);
  if (!cleanup) {
    throw new Error("Expected plugin cleanup");
  }
  onTestFinished(cleanup);
  await eventsFinished.promise;

  expect(collectorErrors).toEqual([]);
  const generations = spans.filter(
    (span) => span.name === "opencode.generation",
  );
  expect(generations).toHaveLength(1);
  expect(
    getJsonAttribute(generations[0], "langfuse.observation.usage_details"),
  ).toEqual({
    input: 10,
    output: 5,
    reasoning: 2,
    cache_read: 3,
    cache_write: 1,
    total: 17,
  });
  expect(
    generations[0].attributes.map((attribute) => attribute.key),
  ).not.toContain("langfuse.observation.cost_details");
});

test("links V2 child sessions prompted before their creation event to the parent trace", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const parentPrompted = Promise.withResolvers<undefined>();
  const parentStepStarted = Promise.withResolvers<undefined>();
  const childPrompted = Promise.withResolvers<undefined>();
  const eventsFinished = Promise.withResolvers<undefined>();
  const parentSessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("v2-parent-session");
  const childSessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("v2-child-session");
  const parentAssistantMessageID = Schema.decodeUnknownSync(MessageIDSchema)(
    "v2-parent-assistant",
  );
  const childAssistantMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-child-assistant");
  const agent = Agent.ID.make("build");
  const model = {
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test-provider"),
  };
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const context = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: toolHooks.register,
    getSession: ({ sessionID }) =>
      Promise.resolve({
        id: sessionID,
        ...(sessionID === childSessionID ? { parentID: parentSessionID } : {}),
        projectID: "test-project",
        cost: 0,
        tokens,
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: "/test" },
      }),
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        await parentPrompted.promise;
        yield {
          type: "session.step.started",
          id: "v2-parent-step-started",
          created: Date.now(),
          durable: {
            aggregateID: parentSessionID,
            seq: 1,
            version: 1 as const,
          },
          data: {
            sessionID: parentSessionID,
            assistantMessageID: parentAssistantMessageID,
            agent,
            model,
          },
        };
        parentStepStarted.resolve(undefined);
        // OpenCode prompts a child session before its creation event is delivered.
        await childPrompted.promise;
        yield {
          type: "session.created",
          id: "v2-child-created",
          created: Date.now(),
          durable: { aggregateID: childSessionID, seq: 1, version: 1 as const },
          data: {
            sessionID: childSessionID,
            projectID: "test-project",
            location: { directory: "/test" },
            parentID: parentSessionID,
            slug: "child",
            version: "2.0.4",
          },
        };
        for (const [sessionID, assistantMessageID] of [
          [childSessionID, childAssistantMessageID],
          [parentSessionID, parentAssistantMessageID],
        ] as const) {
          if (sessionID === childSessionID) {
            yield {
              type: "session.step.started",
              id: `${assistantMessageID}-started`,
              created: Date.now(),
              durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
              data: { sessionID, assistantMessageID, agent, model },
            };
          }
          yield {
            type: "session.step.ended",
            id: `${assistantMessageID}-ended`,
            created: Date.now(),
            durable: { aggregateID: sessionID, seq: 3, version: 1 as const },
            data: {
              sessionID,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens,
            },
          };
          yield {
            type: "session.execution.succeeded",
            id: `${sessionID}-succeeded`,
            created: Date.now(),
            durable: { aggregateID: sessionID, seq: 4, version: 1 as const },
            data: { sessionID },
          };
        }
        eventsFinished.resolve(undefined);
      },
    }),
  });

  const cleanup = await LangfusePlugin.setup(context);
  await sessionHooks.run("prompt", {
    sessionID: parentSessionID,
    messageID: Schema.decodeUnknownSync(MessageIDSchema)("v2-parent-user"),
    prompt: { text: "Delegate this investigation" },
    delivery: "steer",
  });
  parentPrompted.resolve(undefined);
  await parentStepStarted.promise;
  await sessionHooks.run("prompt", {
    sessionID: childSessionID,
    messageID: Schema.decodeUnknownSync(MessageIDSchema)("v2-child-user"),
    prompt: { text: "Inspect the child scope" },
    delivery: "steer",
  });
  childPrompted.resolve(undefined);
  await eventsFinished.promise;
  await cleanup?.();

  expect(collectorErrors).toEqual([]);
  const getSessionSpan = (name: string, sessionID: string) => {
    const span = spans.find(
      (candidate) =>
        candidate.name === name &&
        candidate.attributes.some(
          (attribute) =>
            attribute.key === "session.id" &&
            attribute.value.stringValue === sessionID,
        ),
    );
    if (!span) {
      throw new Error(`Expected ${name} span for ${sessionID}`);
    }
    return span;
  };
  const parentGeneration = getSessionSpan(
    "opencode.generation",
    parentSessionID,
  );
  const childTurn = getSessionSpan("opencode.turn", childSessionID);
  const childGeneration = getSessionSpan("opencode.generation", childSessionID);
  expect(childTurn.traceId).toBe(parentGeneration.traceId);
  expect(childTurn.parentSpanId).toBe(parentGeneration.spanId);
  expect(
    getJsonAttribute(childTurn, "langfuse.observation.metadata"),
  ).toMatchObject({ parentSessionID });
  expect(childGeneration.traceId).toBe(parentGeneration.traceId);
  expect(childGeneration.parentSpanId).toBe(childTurn.spanId);
});

const runtime = vi.hoisted(() => ({
  createLangfuseRuntime: vi.fn(),
  getTraceContext: vi.fn(() => ({})),
  restoreTraceContext: vi.fn(),
  traceUserPrompt: vi.fn(),
  setGenerationInputSnapshot: vi.fn(),
  rememberToolCall: vi.fn(),
  traceToolStart: vi.fn(),
  traceToolError: vi.fn(),
  traceToolEnd: vi.fn(),
  rememberSessionParent: vi.fn(),
  startActiveGenerationStep: vi.fn(),
  traceGeneration: vi.fn(),
  traceFailedGenerationStep: vi.fn(),
  traceSessionError: vi.fn(),
  traceEvent: vi.fn(),
  endActiveToolObservations: vi.fn(),
  endActiveGenerationSteps: vi.fn(),
  endActiveTurnObservations: vi.fn(),
  clearSessionTraceState: vi.fn(),
  clearTraceState: vi.fn(),
  forceFlush: vi.fn(),
}));

vi.mock("../../src/runtime.js", async () => {
  const { Effect } = await import("effect");

  return {
    createLangfuseRuntime: (input: { opencodeVersion?: string }) => {
      runtime.createLangfuseRuntime(input);
      return Effect.succeed({
        ...runtime,
        forceFlush: Effect.sync(runtime.forceFlush),
      });
    },
  };
});

describe("OpenCode 2 package entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves as a plugin object", () => {
    expect(LangfusePlugin.id).toBe("langfuse.observability");
    expect(typeof LangfusePlugin.setup).toBe("function");
  });

  test("exposes both OpenCode plugin APIs from the default entrypoint", () => {
    expect(CombinedPlugin.id).toBe("langfuse.observability");
    expect(typeof CombinedPlugin.setup).toBe("function");
    expect(typeof CombinedPlugin.server).toBe("function");
  });

  test("does not import the OpenCode 2 SDK at runtime", async () => {
    const output = await readFile(
      new URL("../../dist/v2/index.js", import.meta.url),
      "utf8",
    );

    expect(output).not.toContain('from "@opencode/plugin"');
    expect(output).not.toContain("from '@opencode/plugin'");
  });

  test("finalizes and flushes failed executions", async () => {
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: { hook: vi.fn(() => Promise.resolve(registration)) },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield {
              type: "session.step.started",
              created: 100,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                agent: "build",
                model: { id: "model-1", providerID: "provider-1" },
                snapshot: "snapshot-1",
              },
            };
            yield {
              type: "session.execution.failed",
              data: {
                sessionID: "session-1",
                error: { type: "TestError", message: "failed" },
              },
            };
            yield {
              type: "session.step.ended",
              created: 200,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                finish: "stop",
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            };
          },
        }),
      },
    };
    const context = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(context);
    expect(cleanup).toBeTypeOf("function");
    await cleanup?.();

    expect(runtime.createLangfuseRuntime).toHaveBeenCalledWith({
      opencodeVersion: "2.0.4",
    });
    expect(runtime.traceSessionError).toHaveBeenCalledWith({
      sessionID: "session-1",
      error: { name: "TestError", message: "failed" },
    });
    expect(runtime.traceGeneration).not.toHaveBeenCalled();
  });

  test("keeps the shared runtime alive when an instance is disposed and re-created", async () => {
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: { hook: vi.fn(() => Promise.resolve(registration)) },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        }),
      },
    };
    const context = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const firstCleanup = await SourcePlugin.setup(context);
    await firstCleanup?.();
    const secondCleanup = await SourcePlugin.setup(context);
    await secondCleanup?.();

    expect(runtime.createLangfuseRuntime).toHaveBeenCalledTimes(2);
    expect(runtime.forceFlush).toHaveBeenCalledTimes(2);
  });

  test("traces a complete session with prompt, text, reasoning, and tools", async () => {
    let prompt:
      | ((input: {
          sessionID: string;
          messageID: string;
          prompt: { text: string };
        }) => void)
      | undefined;
    let executeBefore:
      | ((input: {
          id: string;
          messageID: string;
          sessionID: string;
          tool: string;
          input: unknown;
        }) => void)
      | undefined;
    let releaseStep: (() => void) | undefined;
    const toolCalled = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    const reasoningReceived = Promise.withResolvers<undefined>();
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: {
        hook: vi.fn((name: string, handler: typeof prompt) => {
          if (name === "prompt") {
            prompt = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      tool: {
        hook: vi.fn((name: string, handler: typeof executeBefore) => {
          if (name === "execute.before") {
            executeBefore = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "session.step.started",
              created: 100,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                agent: "build",
                model: { id: "model-1", providerID: "provider-1" },
                snapshot: "snapshot-1",
              },
            };
            yield {
              type: "session.text.ended",
              created: 150,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                text: "Hello",
              },
            };
            yield {
              type: "session.reasoning.ended",
              created: 160,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                text: "Thinking",
              },
            };
            reasoningReceived.resolve(undefined);
            await toolCalled;
            yield {
              type: "session.step.ended",
              created: 200,
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                finish: "tool-calls",
                cost: 0.01,
                tokens: {
                  input: 10,
                  output: 5,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            };
          },
        }),
      },
    };
    const context = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(context);
    await vi.waitFor(() => {
      expect(prompt).toBeTypeOf("function");
    });
    prompt?.({
      sessionID: "session-1",
      messageID: "user-1",
      prompt: { text: "Say hello" },
    });
    await vi.waitFor(() => {
      expect(executeBefore).toBeTypeOf("function");
    });
    await vi.waitFor(() => {
      expect(runtime.startActiveGenerationStep).toHaveBeenCalled();
    });
    await reasoningReceived.promise;
    executeBefore?.({
      id: "call-1",
      messageID: "assistant-1",
      sessionID: "session-1",
      tool: "read",
      input: { path: "README.md" },
    });
    releaseStep?.();

    await vi.waitFor(() => {
      expect(runtime.traceUserPrompt).toHaveBeenCalledWith({
        sessionID: "session-1",
        messageID: "user-1",
        content: [{ type: "text", text: "Say hello" }],
      });
    });
    await vi.waitFor(() => {
      expect(runtime.traceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          parentID: "user-1",
          output: [
            expect.objectContaining({
              content: [
                { type: "text", text: "Hello" },
                { type: "reasoning", text: "Thinking" },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "read",
                  input: { path: "README.md" },
                  providerExecuted: false,
                },
              ],
            }),
          ],
        }),
      );
    });
    await cleanup?.();
  });

  test.each([false, true])(
    "captures tool output before step completion with providerExecuted=%s and late execution hooks",
    async (executed) => {
      let executeBefore:
        | ((input: {
            id: string;
            messageID: string;
            sessionID: string;
            tool: string;
            input: Record<string, unknown>;
          }) => void)
        | undefined;
      const registration = { dispose: vi.fn(() => Promise.resolve()) };
      const contextInput: unknown = {
        app: { version: "2.0.4" },
        session: { hook: vi.fn(() => Promise.resolve(registration)) },
        tool: {
          hook: vi.fn((name: string, handler: typeof executeBefore) => {
            if (name === "execute.before") {
              executeBefore = handler;
            }
            return Promise.resolve(registration);
          }),
        },
        event: {
          subscribe: () => ({
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield {
                type: "session.step.started",
                created: 100,
                data: {
                  sessionID: "session-1",
                  assistantMessageID: "assistant-1",
                  agent: "build",
                  model: { id: "model-1", providerID: "provider-1" },
                },
              };
              yield {
                type: "session.tool.input.started",
                data: {
                  assistantMessageID: "assistant-1",
                  id: "call-1",
                  name: "read",
                },
              };
              for (let repeat = 0; repeat < 2; repeat++) {
                yield {
                  type: "session.tool.called",
                  data: {
                    assistantMessageID: "assistant-1",
                    id: "call-1",
                    input: { path: "README.md" },
                    executed,
                  },
                };
              }
              yield {
                type: "session.step.ended",
                created: 200,
                data: {
                  sessionID: "session-1",
                  assistantMessageID: "assistant-1",
                  finish: "tool-calls",
                  cost: 0,
                  tokens: {
                    input: 10,
                    output: 5,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
              };
              if (!executed) {
                executeBefore?.({
                  sessionID: "session-1",
                  messageID: "assistant-1",
                  id: "call-1",
                  tool: "read",
                  input: { path: "README.md" },
                });
              }
            },
          }),
        },
      };
      const context = Schema.decodeUnknownSync(
        Schema.declare(
          (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
            typeof input === "object" && input !== null,
        ),
      )(contextInput);
      const cleanup = await SourcePlugin.setup(context);
      await cleanup?.();
      expect(runtime.traceGeneration).toHaveBeenCalledTimes(1);
      expect(runtime.traceGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          output: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "read",
                  input: { path: "README.md" },
                  providerExecuted: executed,
                },
              ],
            },
          ],
        }),
      );
    },
  );

  test("captures the complete model input from each context hook", async () => {
    let context:
      | ((input: {
          sessionID: string;
          system: unknown[];
          messages: unknown[];
          tools: Record<
            string,
            { description: string; input: Record<string, unknown> }
          >;
        }) => void)
      | undefined;
    const registration = { dispose: vi.fn(() => Promise.resolve()) };
    const contextInput: unknown = {
      app: { version: "2.0.4" },
      session: {
        hook: vi.fn((name: string, handler: typeof context) => {
          if (name === "context") {
            context = handler;
          }
          return Promise.resolve(registration);
        }),
      },
      tool: { hook: vi.fn(() => Promise.resolve(registration)) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        }),
      },
    };
    const pluginContext = Schema.decodeUnknownSync(
      Schema.declare(
        (input): input is Parameters<typeof SourcePlugin.setup>[0] =>
          typeof input === "object" && input !== null,
      ),
    )(contextInput);

    const cleanup = await SourcePlugin.setup(pluginContext);
    await vi.waitFor(() => {
      expect(context).toBeTypeOf("function");
    });

    const system = [{ type: "text", text: "System instructions" }];
    const messages = [
      { role: "user", content: [{ type: "text", text: "Earlier message" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] },
    ];
    context?.({
      sessionID: "session-1",
      system,
      messages,
      tools: {
        read: {
          description: "Read a file",
          input: { type: "object", properties: {} },
        },
      },
    });

    expect(runtime.setGenerationInputSnapshot).toHaveBeenCalledWith(
      "session-1",
      {
        system,
        messages,
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    );

    await cleanup?.();
  });
});
