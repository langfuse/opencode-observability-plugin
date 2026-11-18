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

/**
 * opencode completes a shell command that exits non-zero as a normal result and reports the exit code in the result metadata.
 * Returns the error message to trace for such a result, or undefined for any other result.
 */
export const exitFailureMessage = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  output: string | undefined,
) => {
  const exit = metadata?.exit;
  if (typeof exit !== "number" || exit === 0) {
    return undefined;
  }

  return output
    ? `exit code ${exit.toString()}\n${output}`
    : `exit code ${exit.toString()}`;
};
