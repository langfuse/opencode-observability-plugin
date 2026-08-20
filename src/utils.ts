import { Effect } from "effect";

import { OpencodeClientService } from "./opencode.js";

export const log = (level: "info" | "warn" | "error", message: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpencodeClientService;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Existing violation; fix separately.
    yield* Effect.sync(() =>
      opencode.app.log({
        body: { service: "langfuse", level, message },
      }),
    );
  });
