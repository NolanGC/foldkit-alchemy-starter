import type { RuntimeContext } from "alchemy";
import { Stage } from "alchemy";
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

import {
  AuthError,
  BetterAuth,
  BetterAuthPg,
  type AuthUser,
} from "./Auth.ts";
import ChatPersistenceService from "./ChatPersistenceService.ts";
import { RoomId, USER_ID_HEADER, USER_NAME_HEADER } from "./ChatProtocol.ts";
import Room from "./DurableObject.ts";

// Declared as a bare Tag, with `.make()` attaching props + runtime below,
// so the name can be computed from `Stage` — `precreate` reads a directly
// literal `name` field raw (before Input/Output resolution runs), so a
// Stage-derived name only resolves correctly as the *whole* props Effect
// that `.make()` accepts, not as an Effect embedded in one field of a
// plain object.
export class ChatService extends Cloudflare.Worker<
  ChatService,
  Cloudflare.WorkerShape
>()("ChatService") {}

export default ChatService.make(
  Effect.gen(function* () {
    // This whole module (props *and* impl) is bundled as the deployed
    // worker's own script (`main: import.meta.url` below), so this
    // generator body executes a second time inside the actual Workers
    // runtime on cold start — where `Stage` doesn't exist (it's a
    // CLI/plan-time-only service). Guard it the same way alchemy's own
    // binding services do: skip the plan-only lookup once deployed, since
    // a deployed worker never needs its own `name` at runtime, only at
    // precreate/reconcile time on the CLI side.
    const stage = globalThis.__ALCHEMY_RUNTIME__ ? "" : yield* Stage;
    return {
      // Deterministic (stage-only, no random suffix) so alchemy.run.ts's
      // FRONTEND_ORIGIN binding and the Website build's
      // VITE_CHAT_SERVICE_URL can both be computed as plain strings before
      // either worker deploys — no circular dependency on each other's
      // Output. Sanitized the same way as in alchemy.run.ts so both sides
      // derive the identical DNS-safe name.
      name: `chat-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      main: import.meta.url,
      dev: { port: 1339, strictPort: true },
    };
  }),
  Effect.gen(function* () {
    const rooms = yield* Room;
    const persistence = yield* Cloudflare.Workers.bindWorker(
      ChatPersistenceService,
    );
    const auth = yield* BetterAuth;

    // Resolve the caller's session from the request cookie. Runs on every
    // gated route; BetterAuth's cookie cache answers most lookups without
    // touching the database.
    const sessionUser: Effect.Effect<
      Option.Option<AuthUser>,
      AuthError,
      RuntimeContext | HttpServerRequest.HttpServerRequest
    > = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* auth.sessionUser(request.source as Request);
    });

    const unauthorized = HttpServerResponse.text("Unauthorized", {
      status: 401,
    });

    // The auth backend failing is a server-side outage, not a client
    // problem: log it and degrade to a 503 instead of crashing the handler.
    const authUnavailable = (error: AuthError) =>
      Effect.logError("Auth backend unavailable", error.cause).pipe(
        Effect.as(
          HttpServerResponse.text("Service unavailable", { status: 503 }),
        ),
      );

    const cors = HttpMiddleware.cors({
      allowedOrigins: auth.isAllowedOrigin,
      credentials: true,
    });

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          // Credentialed CORS: the session cookie only flows cross-origin
          // when the specific origin is echoed back (a wildcard is invalid
          // with credentials); the allowlist is the deployed frontend.
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
            }).pipe(Effect.catchTag("AuthError", authUnavailable)),
          ),
          HttpRouter.add(
            "GET",
            "/api/rooms",
            Effect.gen(function* () {
              const maybeUser = yield* sessionUser;
              if (Option.isNone(maybeUser)) return unauthorized;
              const roomIds = yield* persistence.listRooms();
              return yield* HttpServerResponse.json(roomIds).pipe(Effect.orDie);
            }).pipe(Effect.catchTag("AuthError", authUnavailable)),
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
              if (origin !== undefined && !auth.isAllowedOrigin(origin)) {
                return HttpServerResponse.text("Forbidden", { status: 403 });
              }
              // The browser sends the session cookie on the upgrade request;
              // reject before the socket ever reaches the room.
              const maybeUser = yield* sessionUser;
              if (Option.isNone(maybeUser)) return unauthorized;
              const user = maybeUser.value;
              const { roomId } = yield* HttpRouter.schemaPathParams(
                S.Struct({ roomId: RoomId }),
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
            }).pipe(Effect.catchTag("AuthError", authUnavailable)),
          ),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
  }).pipe(
    // `Layer.fresh`: ConnectBinding captures the host worker it binds to,
    // and Effect memoizes layer builds globally — without `fresh`, the
    // second worker to build it reuses the first worker's build and the
    // Hyperdrive binding lands on only one of them.
    Effect.provide(
      BetterAuthPg.pipe(
        Layer.provide(Layer.fresh(Cloudflare.Hyperdrive.ConnectBinding)),
      ),
    ),
  ),
);
