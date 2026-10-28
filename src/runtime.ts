import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Data,
  Effect,
  Option,
  Schema,
  SynchronizedRef,
  type SynchronizedRef as SynchronizedRefType,
} from "effect";

import { createLangfuseClient, type LangfuseClient } from "./langfuse.js";

const TagsArraySchema = Schema.Array(Schema.NonEmptyString);

const LangfuseCredentialsSchema = Schema.Struct({
  publicKey: Schema.NonEmptyString,
  secretKey: Schema.NonEmptyString,
  baseUrl: Schema.optional(Schema.NonEmptyString),
  environment: Schema.optional(Schema.NonEmptyString),
  userId: Schema.optional(Schema.NonEmptyString),
  serviceName: Schema.optional(Schema.NonEmptyString),
  tags: Schema.optional(TagsArraySchema),
});

type LangfuseCredentials = typeof LangfuseCredentialsSchema.Type;

const PluginOptionsSchema = Schema.Struct({
  tags: Schema.optional(TagsArraySchema),
});

// Decodes the optional `tags` plugin option. Unknown or malformed values are
// dropped so a bad option never disables tracing for the rest of the config.
export const decodePluginTags = (options: unknown) => {
  const decoded = Schema.decodeUnknownOption(PluginOptionsSchema)(options);
  return Option.isSome(decoded) ? decoded.value.tags?.slice() : undefined;
};

class MissingLangfuseCredentials extends Data.TaggedError(
  "MissingLangfuseCredentials",
)<{ readonly message: string }> {}

class ChangedLangfuseConfiguration extends Data.TaggedError(
  "ChangedLangfuseConfiguration",
)<{ readonly message: string }> {}

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

  const config = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: () =>
      new MissingLangfuseCredentials({
        message: "Missing Langfuse credentials",
      }),
  });

  const credentials = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(
        Schema.fromJsonString(LangfuseCredentialsSchema),
      )(config),
    catch: () =>
      new MissingLangfuseCredentials({
        message: `Invalid Langfuse config at ${configPath}. Check JSON syntax and field types; publicKey and secretKey must be non-empty strings, and "tags" must be an array of non-empty strings if provided`,
      }),
  });

  if (!credentials.publicKey || !credentials.secretKey) {
    return yield* Effect.fail(
      new MissingLangfuseCredentials({
        message: "Missing Langfuse credentials",
      }),
    );
  }

  return credentials;
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

export const createLangfuseRuntime = (input: {
  opencodeVersion?: string;
  tags?: string[];
}) =>
  Effect.gen(function* () {
    const credentials = yield* loadLangfuseCredentials;
    const clientInput = {
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
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
      // Plugin options win over the config file, mirroring how environment
      // variables override it for the other settings.
      tags: input.tags ?? credentials.tags?.slice(),
      opencodeVersion: input.opencodeVersion,
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
