import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Data,
  Effect,
  Schema,
  SynchronizedRef,
  type SynchronizedRef as SynchronizedRefType,
} from "effect";

import { createLangfuseClient, type LangfuseClient } from "./langfuse.js";
import type { RedactionConfig } from "./redaction.js";

const RedactionConfigSchema = Schema.Struct({
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        path: Schema.optional(Schema.NonEmptyString),
        input: Schema.optional(Schema.Literal("as-is", "redact")),
        output: Schema.optional(Schema.Literal("as-is", "redact")),
      }),
    ),
  ),
});

const LangfuseConfigSchema = Schema.Struct({
  publicKey: Schema.optional(Schema.NonEmptyString),
  secretKey: Schema.optional(Schema.NonEmptyString),
  baseUrl: Schema.optional(Schema.NonEmptyString),
  environment: Schema.optional(Schema.NonEmptyString),
  userId: Schema.optional(Schema.NonEmptyString),
  serviceName: Schema.optional(Schema.NonEmptyString),
  redaction: Schema.optional(RedactionConfigSchema),
});
const RedactionOnlySchema = Schema.Struct({
  redaction: Schema.optional(RedactionConfigSchema),
});

class MissingLangfuseCredentials extends Data.TaggedError(
  "MissingLangfuseCredentials",
)<{ readonly message: string }> {}

class ChangedLangfuseConfiguration extends Data.TaggedError(
  "ChangedLangfuseConfiguration",
)<{ readonly message: string }> {}

class InvalidLangfuseConfiguration extends Data.TaggedError(
  "InvalidLangfuseConfiguration",
)<{ readonly message: string }> {}

const loadLangfuseConfig = (useEnvironmentCredentials: boolean) =>
  Effect.tryPromise({
    try: async (): Promise<typeof LangfuseConfigSchema.Type> => {
      const path = join(
        homedir(),
        ".config",
        "opencode",
        "opencode-langfuse.json",
      );
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return {};
        }
        throw error;
      }
      const document = Schema.decodeUnknownSync(Schema.parseJson())(contents);
      if (
        typeof document === "object" &&
        document !== null &&
        "redaction" in document
      ) {
        Schema.decodeUnknownSync(RedactionConfigSchema, {
          onExcessProperty: "error",
        })(document.redaction);
      }
      return useEnvironmentCredentials
        ? Schema.decodeUnknownSync(RedactionOnlySchema)(document)
        : Schema.decodeUnknownSync(LangfuseConfigSchema)(document);
    },
    catch: () =>
      new InvalidLangfuseConfiguration({
        message: "Invalid Langfuse configuration",
      }),
  });

/**
 * opencode disposes and re-creates plugin instances inside the same process
 * (e.g. when the effective config changes) while the OTel tracer provider is
 * registered process-wide and cannot be registered a second time. Spans are
 * exported by that first provider, so a re-created instance has to keep using
 * the client that owns it: flushing or shutting down a second provider would
 * silently drop the session.
 *
 * Symbol.for keeps the owner stable if the package is loaded more than once.
 */
type SharedClientState =
  | { readonly _tag: "Empty" }
  | {
      readonly _tag: "Ready";
      readonly client: LangfuseClient;
      readonly key: string;
    };

declare global {
  var langfuseOpencodeRuntimeState:
    | SynchronizedRefType.SynchronizedRef<SharedClientState>
    | undefined;
}

export const createLangfuseRuntime = (input: { opencodeVersion?: string }) =>
  Effect.gen(function* () {
    const useEnvironmentCredentials =
      process.env.LANGFUSE_PUBLIC_KEY !== undefined &&
      process.env.LANGFUSE_PUBLIC_KEY !== "" &&
      process.env.LANGFUSE_SECRET_KEY !== undefined &&
      process.env.LANGFUSE_SECRET_KEY !== "";
    const config = yield* loadLangfuseConfig(useEnvironmentCredentials);
    const credentials = useEnvironmentCredentials
      ? {
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl:
            process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL,
          environment: process.env.LANGFUSE_ENVIRONMENT,
          userId: process.env.LANGFUSE_USER_ID,
          serviceName: process.env.LANGFUSE_SERVICE_NAME,
        }
      : config;
    const { publicKey, secretKey } = credentials;
    if (publicKey === undefined || secretKey === undefined) {
      return yield* Effect.fail(
        new MissingLangfuseCredentials({
          message: "Missing Langfuse credentials",
        }),
      );
    }
    const clientInput = {
      publicKey,
      secretKey,
      baseUrl:
        credentials.baseUrl ??
        process.env.LANGFUSE_BASE_URL ??
        process.env.LANGFUSE_BASEURL ??
        "https://cloud.langfuse.com",
      environment:
        credentials.environment ??
        process.env.LANGFUSE_ENVIRONMENT ??
        "development",
      userId: credentials.userId ?? process.env.LANGFUSE_USER_ID,
      serviceName: credentials.serviceName ?? process.env.LANGFUSE_SERVICE_NAME,
      opencodeVersion: input.opencodeVersion,
      redaction: (config.redaction ?? {}) satisfies RedactionConfig,
    } satisfies Parameters<typeof createLangfuseClient>[0];
    const cacheKey = JSON.stringify(clientInput);
    const sharedClientState =
      globalThis.langfuseOpencodeRuntimeState ??
      Effect.runSync(
        SynchronizedRef.make<SharedClientState>({ _tag: "Empty" }),
      );
    globalThis.langfuseOpencodeRuntimeState = sharedClientState;

    return yield* SynchronizedRef.modifyEffect(sharedClientState, (state) =>
      Effect.gen(function* () {
        if (state._tag === "Ready") {
          if (state.key !== cacheKey) {
            return yield* Effect.fail(
              new ChangedLangfuseConfiguration({
                message:
                  "Langfuse configuration changed while the process-wide OpenTelemetry provider is active; restart OpenCode to apply it",
              }),
            );
          }

          return [state.client, state] as const;
        }

        const client = yield* createLangfuseClient(clientInput);
        const nextState = {
          _tag: "Ready",
          client,
          key: cacheKey,
        } as const satisfies SharedClientState;

        return [client, nextState] as const;
      }),
    );
  });
