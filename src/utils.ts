import { Effect } from "effect";

import { OpencodeClientService } from "./opencode.js";

export const log = (level: "info" | "warn" | "error", message: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeClientService;

    yield* Effect.tryPromise(() =>
      opencode.app.log({
        body: { service: "langfuse", level, message },
      }),
    );
  });

const describeValue = (value: unknown) => {
  if (
    typeof value === "string" ||
    value === undefined ||
    typeof value === "function"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Circular structures or BigInt values.
    return "[unserializable value]";
  }
};

/**
 * Renders an error together with everything wrapped inside it. Effect's
 * `UnknownError` and OpenTelemetry exporters hide the actual reason (network
 * code, HTTP status, response body) in `cause`, `errors`, `code`, and `data`.
 */
export const formatError = (error: unknown) => {
  const seen = new Set<unknown>();

  const describe = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(describe).join("; ")}]`;
    }
    if (!(value instanceof Error)) {
      return describeValue(value);
    }
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    const details = [
      "code" in value && value.code !== undefined
        ? `code: ${describeValue(value.code)}`
        : undefined,
      "data" in value && value.data !== undefined
        ? `data: ${describeValue(value.data)}`
        : undefined,
    ].filter((detail) => detail !== undefined);

    return [
      String(value),
      details.length > 0 ? ` (${details.join(", ")})` : "",
      value instanceof AggregateError ? ` ${describe(value.errors)}` : "",
      value.cause !== undefined ? `; caused by ${describe(value.cause)}` : "",
    ].join("");
  };

  return describe(error);
};
