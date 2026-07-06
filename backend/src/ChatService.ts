import * as Cloudflare from "alchemy/Cloudflare";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

import ChatPersistenceService from "./ChatPersistenceService.ts";
import Room from "./DurableObject.ts";

// The frontend is served from a different origin than this worker, so the
// rooms endpoint must be CORS-readable. GET-only and credential-free, so a
// wildcard is fine.
const corsHeaders = { "access-control-allow-origin": "*" };

export default class ChatService extends Cloudflare.Worker<ChatService>()(
  "ChatService",
  {
    main: import.meta.url,
    dev: { port: 1339, strictPort: true },
  },
  Effect.gen(function* () {
    const rooms = yield* Room;
    const persistence = yield* Cloudflare.Workers.bindWorker(
      ChatPersistenceService,
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
          HttpRouter.add(
            "GET",
            "/api/rooms",
            persistence
              .listRooms()
              .pipe(
                Effect.flatMap((roomIds) =>
                  HttpServerResponse.json(roomIds, { headers: corsHeaders }),
                ),
              ),
          ),
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
              const knownRooms = yield* persistence.listRooms();
              if (!Array.contains(knownRooms, roomId)) {
                return HttpServerResponse.text("Room not found", {
                  status: 404,
                });
              }
              const room = rooms.getByName(roomId);
              return yield* room.fetch(request);
            }),
          ),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
  }),
) {}
