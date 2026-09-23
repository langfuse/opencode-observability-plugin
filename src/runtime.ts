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

  const credentials = yield* Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownSync(Schema.parseJson(LangfuseCredentialsSchema))(
        await readFile(configPath, "utf8"),
      ),
    catch: () =>
      new MissingLangfuseCredentials({
        message: "Missing Langfuse credentials",
      }),
  }).pipe(
    Effect.mapError(
      () =>
        new MissingLangfuseCredentials({
          message: "Missing Langfuse credentials",
        }),
    ),
  );

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

export const createLangfuseRuntime = (input: { opencodeVersion?: string }) =>
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
