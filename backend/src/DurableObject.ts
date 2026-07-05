import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top
// TODO: testing (as described in docs)

export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const sessions = new Map<string, Cloudflare.WebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<{ id: string }>();
        if (data) sessions.set(data.id, socket);
      }

      const broadcast = (text: string) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            sessions.values(),
            (peer) => peer.send(text),
            { concurrency: 32 },
          );
        });

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = crypto.randomUUID();

          socket.serializeAttachment({ id });
          sessions.set(id, socket);

          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<{ id: string }>();
          if (!attachment) return;

          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);

          yield* broadcast(`[${attachment.id.slice(0, 8)}] ${text}`);
        }),
        webSocketClose: Effect.fn(function* (
          ws: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = ws.deserializeAttachment<{ id: string }>();
          if (attachment) sessions.delete(attachment.id);
          yield* ws.close(code, reason);
        }),
        broadcast,
      };
    });
  }),
) {}
