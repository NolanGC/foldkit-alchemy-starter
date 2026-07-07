import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

import { BetterAuth, isAllowedOrigin, type AuthUser } from "./Auth.ts";
import ChatPersistenceService from "./ChatPersistenceService.ts";
import { USER_ID_HEADER, USER_NAME_HEADER } from "./ChatProtocol.ts";
import Room from "./DurableObject.ts";

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
    const auth = yield* BetterAuth;

    // Resolve the caller's session from the request cookie. Runs on every
    // gated route; BetterAuth's session lookup is a single indexed query
    // through Hyperdrive.
    const sessionUser: Effect.Effect<
      Option.Option<AuthUser>,
      never,
      RuntimeContext | HttpServerRequest.HttpServerRequest
    > = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* auth.sessionUser(request.source as Request);
    });

    const unauthorized = HttpServerResponse.text("Unauthorized", {
      status: 401,
    });

    const cors = HttpMiddleware.cors({
      allowedOrigins: isAllowedOrigin,
      credentials: true,
    });

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          // Credentialed CORS: the session cookie only flows cross-origin
          // when the specific origin is echoed back (a wildcard is invalid
          // with credentials), so the policy lives in `isAllowedOrigin`.
          // WebSocket upgrades are exempt: browsers don't enforce CORS on
          // them, and the 101 response's headers are immutable in workerd,
          // so appending CORS headers to it crashes the upgrade. The WS
          // route does its own Origin check instead.
          HttpRouter.middleware(
            (app) =>
              Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
                request.headers.upgrade === "websocket" ? app : cors(app),
              ),
            { global: true },
          ),
          HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
          // BetterAuth owns everything under /api/auth/* (sign-up, sign-in,
          // sign-out, get-session, and OAuth callbacks later).
          HttpRouter.add(
            "*",
            "/api/auth/*",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const source = request.source as Request;
              const response = yield* auth.withAuth(source.url, (instance) =>
                instance.handler(source),
              );
              return HttpServerResponse.fromWeb(response);
            }),
          ),
          HttpRouter.add(
            "GET",
            "/api/rooms",
            Effect.gen(function* () {
              const maybeUser = yield* sessionUser;
              if (Option.isNone(maybeUser)) return unauthorized;
              const roomIds = yield* persistence.listRooms();
              return yield* HttpServerResponse.json(roomIds).pipe(Effect.orDie);
            }),
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
              // CORS never applied to WebSockets, so the upgrade needs its
              // own Origin check: the session cookie is SameSite=None and
              // would otherwise ride along on a hostile site's `new
              // WebSocket(...)` (cross-site WebSocket hijacking).
              const origin = request.headers.origin;
              if (origin !== undefined && !isAllowedOrigin(origin)) {
                return HttpServerResponse.text("Forbidden", { status: 403 });
              }
              // The browser sends the session cookie on the upgrade request;
              // reject before the socket ever reaches the room.
              const maybeUser = yield* sessionUser;
              if (Option.isNone(maybeUser)) return unauthorized;
              const user = maybeUser.value;
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
              // Forward the verified identity to the Durable Object as
              // headers; the DO trusts them because it is only reachable
              // through this worker.
              const source = request.source as Request;
              const headers = new Headers(source.headers);
              headers.set(USER_ID_HEADER, user.id);
              headers.set(USER_NAME_HEADER, encodeURIComponent(user.name));
              return yield* room.fetch(
                HttpServerRequest.fromWeb(new Request(source, { headers })),
              );
            }),
          ),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
    // `Layer.fresh`: this layer captures the host worker it binds to, and
    // Effect memoizes layer builds globally — without `fresh`, the second
    // worker to build it reuses the first worker's build and the Hyperdrive
    // binding lands on only one of them.
  }).pipe(Effect.provide(Layer.fresh(Cloudflare.Hyperdrive.ConnectBinding))),
) {}
