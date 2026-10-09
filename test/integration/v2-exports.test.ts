import { createServer } from "node:http";

import LangfusePlugin from "@langfuse/opencode-observability-plugin/v2";
import { Agent, Model, Provider } from "@opencode/plugin";
import type { Hooks } from "@opencode/plugin/promise/registration";
import type { SessionHooks as SessionHookInputs } from "@opencode/plugin/promise/session";
import { CallID, Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { expect, onTestFinished, test, vi } from "vitest";

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

test("exports V2 parallel tool responses with explicit IDs and no duplicate context results", async () => {
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
        const payload = Schema.decodeUnknownSync(PayloadSchema)(
          Buffer.concat(chunks).toString("utf8"),
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
      run: async <Name extends keyof Inputs>(
        name: Name,
        input: Inputs[Name],
      ) => {
        const handler = hooks[name];
        if (!handler) {
          throw new Error(`Expected hook ${String(name)}`);
        }
        await handler(input);
      },
    };
  };
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const eventsFinished = Promise.withResolvers<undefined>();

  const sessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("v2-parallel-tools");
  const assistantMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-tool-generation");
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
  const toolCalls = calls.map((call) => ({
    id: call.id,
    name: "read",
    arguments: JSON.stringify({ path: call.path }),
  }));
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
      content: calls.map((call) => ({
        type: "tool-call" as const,
        id: call.id,
        name: "read",
        input: { path: call.path },
      })),
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
  const unexpectedApi = () => {
    throw new Error("The plugin used an unsupported mock host capability");
  };
  const contextInput = {
    app: { name: "opencode", version: "2.0.4", channel: "stable" },
    session: {
      hook: sessionHooks.register,
      create: unexpectedApi,
      get: unexpectedApi,
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
      hook: toolHooks.register,
      transform: unexpectedApi,
      reload: unexpectedApi,
    },
    event: {
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
            for (const call of calls) {
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
              const input = {
                sessionID,
                messageID: assistantMessageID,
                agent,
                tool: "read",
                id: call.id,
                input: { path: call.path },
              };
              const resultsByStatus = {
                error: {
                  ...input,
                  status: "error" as const,
                  error: new ToolError({ message: call.content }),
                },
                completed: {
                  ...input,
                  status: "completed" as const,
                  result: {
                    content:
                      call.id === "v2-call-second"
                        ? [
                            { type: "text" as const, text: "Second" },
                            { type: "text" as const, text: "response" },
                          ]
                        : call.content,
                  },
                },
              } satisfies Record<
                (typeof calls)[number]["status"],
                Parameters<ToolHook>[0]
              >;
              const result = resultsByStatus[call.status];
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
                assistantMessageID: "v2-followup",
                agent,
                model,
              },
            };
            yield {
              id: "v2-followup-ended",
              durable: { aggregateID: sessionID, seq: 4, version: 1 as const },
              type: "session.step.ended",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID: "v2-followup",
                finish: "stop",
                cost: 0,
                tokens,
              },
            };
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
    },
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
    get storage() {
      return unexpectedApi();
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
  const generation = generations.find(
    (span) => span.spanId === tools[0].parentSpanId,
  );
  const followup = generations.find((span) => span !== generation);
  if (!generation || !followup) {
    throw new Error("Expected both generations");
  }
  expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual([
    { role: "assistant", content: "", tool_calls: toolCalls },
  ]);
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
    messages,
    tools: [],
  });
});
