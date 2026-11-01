import type { BoardEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

export class MessageBoardHandlingEvents extends Context.Service<
  MessageBoardHandlingEvents,
  { readonly changes: PubSub.PubSub<BoardEvent> }
>()("t3/messageBoard/MessageBoardHandlingEvents") {}
export const layer = Layer.effect(
  MessageBoardHandlingEvents,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<BoardEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    return { changes };
  }),
);
