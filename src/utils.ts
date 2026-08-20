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
