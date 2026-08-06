import type { PluginInput } from "@opencode-ai/plugin";
import { Context as EffectContext } from "effect";

export type OpencodeClient = Pick<PluginInput["client"], "app" | "tool">;

export class OpencodeClientService extends EffectContext.Tag(
  "OpencodeClientService",
)<OpencodeClientService, OpencodeClient>() {}
