import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { Data, Effect, Layer, Option, Schema } from "effect";

import {
  LangfuseClientService,
  createLangfuseClient,
  type LangfuseClient,
  type ToolDefinition,
} from "./langfuse.js";
import { OpencodeClientService } from "./opencode.js";
import { log } from "./utils.js";

// opencode emits these session.next.* events at runtime, but the published
// @opencode-ai/plugin Hooks["event"] type still omits them from its Event union.
type SessionNextEvent =
  | {
      id: string;
      type: "session.next.step.started";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID?: string;
        agent: string;
        model: Parameters<
          LangfuseClient["startActiveGenerationStep"]
        >[0]["model"];
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.ended";
      properties: { sessionID: string; timestamp: number };
    }
  | {
      id: string;
      type: "session.next.step.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID?: string;
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

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

const LangfuseCredentialsSchema = Schema.Struct({
  publicKey: Schema.NonEmptyString,
  secretKey: Schema.NonEmptyString,
  baseUrl: Schema.optional(Schema.NonEmptyString),
  environment: Schema.optional(Schema.NonEmptyString),
  userId: Schema.optional(Schema.NonEmptyString),
  serviceName: Schema.optional(Schema.NonEmptyString),
});

type LangfuseCredentials = typeof LangfuseCredentialsSchema.Type;

class MissingLangfuseCredentials extends Data.TaggedError(
  "MissingLangfuseCredentials",
) {}

const loadLangfuseCredentials = Effect.gen(function* () {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (
    publicKey !== undefined &&
    publicKey !== "" &&
    secretKey !== undefined &&
    secretKey !== ""
  ) {
    return {
      publicKey,
      secretKey,
      // Prefer the canonical name while retaining the legacy name for semver compatibility.
      baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL,
      environment: process.env.LANGFUSE_ENVIRONMENT,
      userId: process.env.LANGFUSE_USER_ID,
      serviceName: process.env.LANGFUSE_SERVICE_NAME,
    } satisfies LangfuseCredentials;
  }

  const configPath = join(
    homedir(),
    ".config",
    "opencode",
    "opencode-langfuse.json",
  );

  const credentials = yield* Effect.tryPromise({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Existing violation tracked for incremental cleanup.
    try: async () => JSON.parse(await readFile(configPath, "utf8")),
    catch: () => new MissingLangfuseCredentials(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(LangfuseCredentialsSchema)),
    Effect.mapError(() => new MissingLangfuseCredentials()),
  );

  if (!credentials.publicKey || !credentials.secretKey) {
    return yield* Effect.fail(new MissingLangfuseCredentials());
  }

  return credentials;
});

const eventHook = (event: OpencodeEvent, shutdown?: () => Promise<void>) =>
  Effect.gen(function* () {
    const langfuse = yield* LangfuseClientService;

    const finalizeSessionTracing = (sessionID?: string) => {
      langfuse.endActiveToolObservations(sessionID);
      langfuse.endActiveGenerationSteps(sessionID);
      langfuse.endActiveTurnObservations(sessionID);

      if (sessionID !== undefined && sessionID !== "") {
        langfuse.clearSessionTraceState(sessionID);
      } else {
        langfuse.clearTraceState();
      }
    };

    if (event.type === "session.idle") {
      yield* log("info", "Flushing spans");
      finalizeSessionTracing(event.properties.sessionID);

      yield* langfuse.forceFlush;
    }

    if (event.type === "server.instance.disposed") {
      finalizeSessionTracing();

      if (shutdown) {
        yield* Effect.tryPromise({
          try: () => shutdown(),
          catch: (error) => error,
        });
      }
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      langfuse.rememberSessionParent({
        sessionID: event.properties.info.id,
        parentSessionID: event.properties.info.parentID,
      });
    }

    if (event.type === "session.deleted") {
      langfuse.rememberSessionParent({
        sessionID: event.properties.info.id,
      });
    }

    if (event.type === "session.error" && event.properties.sessionID != null) {
      langfuse.traceSessionError({
        sessionID: event.properties.sessionID,
        error: event.properties.error,
      });
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part;

      langfuse.rememberAssistantPart(part);
      langfuse.traceReasoningPart(part);

      if (part.type === "tool" && part.state.status === "running") {
        langfuse.traceToolStart({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          started: part.state.time.start,
        });
      }

      if (part.type === "tool" && part.state.status === "completed") {
        langfuse.traceToolEnd({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          title: part.state.title,
          output: part.state.output,
          started: part.state.time.start,
          completed: part.state.time.end,
        });
      }

      if (part.type === "tool" && part.state.status === "error") {
        langfuse.traceToolError({
          sessionID: part.sessionID,
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          args: part.state.input,
          error: part.state.error,
          started: part.state.time.start,
          completed: part.state.time.end,
        });
      }
    }

    if (event.type === "session.next.step.started") {
      langfuse.startActiveGenerationStep({
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        agent: event.properties.agent,
        model: event.properties.model,
        started: event.properties.timestamp,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.failed") {
      langfuse.traceFailedGenerationStep({
        id: event.id,
        sessionID: event.properties.sessionID,
        assistantMessageID: event.properties.assistantMessageID,
        completed: event.properties.timestamp,
        error: event.properties.error,
      });
    }

    if (
      event.type === "session.next.tool.called" &&
      event.properties.assistantMessageID != null
    ) {
      langfuse.rememberToolCall({
        callID: event.properties.callID,
        messageID: event.properties.assistantMessageID,
        sessionID: event.properties.sessionID,
        tool: event.properties.tool,
        args: event.properties.input,
      });
    }

    if (event.type === "session.next.retried") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.retry",
        timestamp: event.properties.timestamp,
        output: event.properties.error,
        metadata: {
          attempt: event.properties.attempt,
        },
      });
    }

    if (event.type === "session.next.reasoning.ended") {
      langfuse.rememberReasoning({
        reasoningID: event.properties.reasoningID,
        sessionID: event.properties.sessionID,
        timestamp: event.properties.timestamp,
        text: event.properties.text,
        messageID: event.properties.assistantMessageID,
      });
    }

    if (event.type === "session.next.compaction.ended") {
      langfuse.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.compaction",
        timestamp: event.properties.timestamp,
        output: { text: event.properties.text },
        metadata: {
          include: event.properties.include,
        },
      });
    }

    if (event.type === "message.updated") {
      const message = event.properties.info;

      if (message.role !== "assistant") {
        return;
      }

      langfuse.startActiveGenerationStep({
        sessionID: message.sessionID,
        assistantMessageID: message.id,
        agent: message.mode,
        model: {
          id: message.modelID,
          providerID: message.providerID,
        },
        started: message.time.created,
      });

      if (message.time.completed === undefined) {
        return;
      }

      langfuse.traceGeneration({
        sessionID: message.sessionID,
        messageID: message.id,
        parentID: message.parentID,
        modelID: message.modelID,
        providerID: message.providerID,
        agent: message.mode,
        mode: message.mode,
        created: message.time.created,
        completed: message.time.completed,
        finish: message.finish,
        cost: message.cost,
        tokens: message.tokens,
      });
    }
  });

const formatHookError = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/tool/tool.ts#L46-L52
const NativeToolResultSchema = Schema.Struct({
  title: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  output: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

// OpenCode returns CallToolResultSchema from its MCP adapter and passes that raw
// value to the hook before normalization:
// https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/mcp/index.ts#L158-L187
const McpToolResultSchema = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

const McpResourceContentsSchema = Schema.Union(
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    text: Schema.String,
  }),
  Schema.Struct({
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    blob: Schema.String,
  }),
);

// These are the MCP content variants OpenCode handles when creating its native
// output: https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/session/tools.ts#L153-L176
const McpContentSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.String,
    mimeType: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: McpResourceContentsSchema,
  }),
);

const flattenMcpContent = (content: readonly unknown[]) => {
  const textParts: string[] = [];

  for (const part of content) {
    const decoded = Schema.decodeUnknownOption(McpContentSchema)(part);
    // eslint-disable-next-line curly -- Existing violation, fixed in a follow-up commit.
    if (Option.isNone(decoded)) continue;

    if (decoded.value.type === "text") {
      textParts.push(decoded.value.text);
      continue;
    }

    if (decoded.value.type === "resource" && "text" in decoded.value.resource) {
      textParts.push(decoded.value.resource.text);
    }
  }

  return textParts.join("\n\n");
};

const normalizeToolResult = (tool: string, output: unknown) => {
  const nativeResult = Schema.decodeUnknownOption(NativeToolResultSchema)(
    output,
  );
  if (Option.isSome(nativeResult)) {
    return {
      title: nativeResult.value.title,
      output: nativeResult.value.output,
      isError: false,
      unexpected: false,
    };
  }

  const mcpResult = Schema.decodeUnknownOption(McpToolResultSchema)(output);
  if (Option.isSome(mcpResult)) {
    return {
      title: tool,
      output: flattenMcpContent(mcpResult.value.content),
      isError: mcpResult.value.isError === true,
      unexpected: false,
    };
  }
  if (output === undefined || output === null) {
    return { title: tool, output: "", isError: false, unexpected: false };
  }

  return { title: tool, output: "", isError: false, unexpected: true };
};

const createShutdownOnce = (langfuse: LangfuseClient) => {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Existing violation tracked for incremental cleanup.
    if (!shutdownPromise) {
      shutdownPromise = Effect.runPromise(langfuse.shutdown);
    }

    return shutdownPromise;
  };
};

const main = Effect.gen(function* () {
  const opencode = yield* OpencodeClientService;

  const langfuse = yield* Effect.gen(function* () {
    const credentials = yield* loadLangfuseCredentials;

    const baseUrl =
      credentials.baseUrl ??
      // Prefer the canonical name while retaining the legacy name for semver compatibility.
      process.env.LANGFUSE_BASE_URL ??
      process.env.LANGFUSE_BASEURL ??
      "https://cloud.langfuse.com";

    const environment =
      credentials.environment ??
      process.env.LANGFUSE_ENVIRONMENT ??
      "development";

    const userId = credentials.userId ?? process.env.LANGFUSE_USER_ID;

    const serviceName =
      credentials.serviceName ?? process.env.LANGFUSE_SERVICE_NAME;

    return yield* createLangfuseClient({
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
      baseUrl,
      environment,
      userId,
      serviceName,
    });
  }).pipe(
    Effect.tap((client) =>
      log("info", `OTEL tracing initialized → ${client.baseUrl}`),
    ),
    Effect.catchTag("MissingLangfuseCredentials", () =>
      log("warn", "[Tracing disabled] Missing langfuse credentials"),
    ),
  );

  if (!langfuse) {
    return {};
  }

  const hooksLayer = Layer.merge(
    Layer.succeed(OpencodeClientService, opencode),
    Layer.succeed(LangfuseClientService, langfuse),
  );

  const finalizeTracing = Effect.sync(() => {
    langfuse.endActiveToolObservations();
    langfuse.endActiveGenerationSteps();
    langfuse.endActiveTurnObservations();
    langfuse.clearTraceState();
  });
  const shutdownOnce = createShutdownOnce(langfuse);
  const toolDefinitions = new Map<string, Promise<ToolDefinition[]>>();

  const runHook = (
    hookName: string,
    effect: Effect.Effect<
      unknown,
      unknown,
      OpencodeClientService | LangfuseClientService
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchAllDefect((defect) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(defect)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.catchAll((error) =>
          log(
            "error",
            `Langfuse hook "${hookName}" failed: ${formatHookError(error)}`,
          ).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.asVoid,
        Effect.provide(hooksLayer),
      ),
    );

  const hooks: Hooks = {
    dispose: () =>
      runHook(
        "dispose",
        finalizeTracing.pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: () => shutdownOnce(),
              catch: (error) => error,
            }),
          ),
        ),
      ),

    config: (config) =>
      runHook(
        "config",
        Effect.gen(function* () {
          if (config.experimental?.openTelemetry !== true) {
            yield* log(
              "warn",
              "[Tracing disabled] Please enable `experimental.openTelemetry` in your opencode.jsonc to use the Langfuse plugin",
            );
          }
        }),
      ),

    event: ({ event }) => runHook("event", eventHook(event, shutdownOnce)),

    "chat.message": (input, output) =>
      runHook(
        "chat.message",
        Effect.gen(function* () {
          let tools: ToolDefinition[] | undefined;

          if (input.model) {
            const enabledTools = output.message.tools;
            const cacheKey = JSON.stringify([
              input.model.providerID,
              input.model.modelID,
              enabledTools,
            ]);
            let pendingTools = toolDefinitions.get(cacheKey);

            if (!pendingTools) {
              pendingTools = opencode.tool
                .list({
                  query: {
                    provider: input.model.providerID,
                    model: input.model.modelID,
                  },
                })
                .then(({ data }) =>
                  (data ?? [])
                    .filter((tool) => enabledTools?.[tool.id] !== false)
                    .map((tool) => ({
                      name: tool.id,
                      description: tool.description,
                      ...(typeof tool.parameters === "object" &&
                      tool.parameters !== null &&
                      !Array.isArray(tool.parameters)
                        ? {
                            parameters: tool.parameters,
                          }
                        : {}),
                    })),
                )
                .catch(() => {
                  toolDefinitions.delete(cacheKey);
                  return [];
                });
              toolDefinitions.set(cacheKey, pendingTools);
            }

            tools = yield* Effect.promise(() => pendingTools);
          }

          yield* Effect.sync(() => {
            langfuse.traceUserMessage({
              sessionID: input.sessionID,
              messageID: input.messageID,
              agent: input.agent,
              model: input.model,
              parts: output.parts,
              tools,
            });
          });
        }),
      ),

    "tool.execute.before": (input, output) =>
      runHook(
        "tool.execute.before",
        Effect.try({
          try: () => {
            langfuse.traceToolStart({
              sessionID: input.sessionID,
              callID: input.callID,
              tool: input.tool,
              args: output.args,
            });
          },
          catch: (error) => error,
        }),
      ),

    "tool.execute.after": (input, output) =>
      runHook(
        "tool.execute.after",
        Effect.gen(function* () {
          const normalized = normalizeToolResult(input.tool, output);

          if (normalized.unexpected) {
            yield* log(
              "warn",
              `Tool "${input.tool}" returned an unrecognized result shape; recording empty output`,
            );
          }

          if (normalized.isError) {
            yield* Effect.sync(() => {
              langfuse.traceToolError({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: input.args,
                error:
                  normalized.output ||
                  `MCP tool "${input.tool}" returned an error`,
                completed: Date.now(),
              });
            });
            return;
          }

          yield* Effect.try({
            try: () => {
              langfuse.traceToolEnd({
                sessionID: input.sessionID,
                callID: input.callID,
                tool: input.tool,
                args: input.args,
                title: normalized.title,
                output: normalized.output,
              });
            },
            catch: (error) => error,
          });
        }),
      ),
  };

  return hooks;
});

export const LangfusePlugin: Plugin = async ({ client }) => {
  const clientLayer = Layer.succeed(OpencodeClientService, client);

  return Effect.runPromise(main.pipe(Effect.provide(clientLayer)));
};

export default LangfusePlugin;
