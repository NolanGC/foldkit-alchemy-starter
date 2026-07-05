import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

import Room from "./DurableObject.ts";

export default class ChatService extends Cloudflare.Worker<ChatService>()(
  "ChatService",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const rooms = yield* Room;

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
          HttpRouter.add(
            "GET",
            "/api/chat/:roomId",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.upgrade !== "websocket") {
                return HttpServerResponse.text("Expected Upgrade: websocket", {
                  status: 426,
                });
              }
              const { roomId } = yield* HttpRouter.schemaPathParams(
                S.Struct({ roomId: S.String }),
              ).pipe(Effect.orDie);
              const room = rooms.getByName(roomId);
              return yield* room.fetch(request);
            }),
          ),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
  }),
) {}
