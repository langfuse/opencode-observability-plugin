import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Data, Effect, Schema } from "effect";

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

export const createLangfuseRuntime = (input: { opencodeVersion?: string }) =>
  Effect.gen(function* () {
    const credentials = yield* loadLangfuseCredentials;
    const client = yield* createLangfuseClient({
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
    });

    return client;
  });

export const createShutdownOnce = (langfuse: LangfuseClient) => {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    return (shutdownPromise ??= Effect.runPromise(langfuse.shutdown));
  };
};
