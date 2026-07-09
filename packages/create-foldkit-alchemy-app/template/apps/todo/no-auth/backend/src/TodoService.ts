import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { asc, eq } from "drizzle-orm";
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

import { Hyperdrive } from "./Db.ts";
import {
  CreateTodoRequest,
  MAX_TODO_TITLE_LENGTH,
  TodoId,
  UpdateTodoRequest,
  type Todo,
} from "./TodoProtocol.ts";
import { Todos, type TodoRow } from "./schema.ts";

// The wire shape is `Todo`'s encoded form: `createdAt` travels as epoch
// millis (`S.DateTimeUtcFromMillis`).
const toWireTodo = (row: TodoRow): typeof Todo.Encoded => ({
  id: row.id,
  title: row.title,
  completed: row.completed,
  createdAt: row.createdAt.getTime(),
});

// Declared as a bare Tag, with `.make()` attaching props + runtime below,
// so the name can be computed from `Stage` — `precreate` reads a directly
// literal `name` field raw (before Input/Output resolution runs), so a
// Stage-derived name only resolves correctly as the *whole* props Effect
// that `.make()` accepts, not as an Effect embedded in one field of a
// plain object.
export class TodoService extends Cloudflare.Worker<
  TodoService,
  Cloudflare.WorkerShape
>()("TodoService") {}

export default TodoService.make(
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
      // Deterministic (stage-only, no random suffix) so alchemy.run.ts can
      // compute VITE_API_URL and FRONTEND_ORIGIN as plain strings before
      // either worker deploys — no circular dependency on each other's
      // Output. Sanitized the same way as in alchemy.run.ts so both sides
      // derive the identical DNS-safe name.
      name: `__PROJECT_NAME__-api-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      main: import.meta.url,
      dev: { port: 1339, strictPort: true },
    };
  }),
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString);
    const env = yield* Cloudflare.Workers.WorkerEnvironment;

    // FRONTEND_ORIGIN is a plain-text binding attached in alchemy.run.ts
    // (the Website's URL). Read lazily: it only exists at runtime, and this
    // effect also builds at plan time. Only the frontend's origin may call
    // the API cross-origin; an unset binding (a wiring bug, or the first
    // deploy of a fresh stage racing the Website URL) denies everything.
    const isAllowedOrigin = (origin: string): boolean => {
      const raw = env.FRONTEND_ORIGIN as string | undefined;
      return raw !== undefined && new URL(raw).origin === origin;
    };

    const cors = HttpMiddleware.cors({ allowedOrigins: isAllowedOrigin });

    const notFound = HttpServerResponse.text("Todo not found", {
      status: 404,
    });

    // Path params are validated against the branded `TodoId`; a malformed
    // id can't reference a todo, so it reads as 404 rather than 400.
    const todoIdParam = HttpRouter.schemaPathParams(
      S.Struct({ id: TodoId }),
    ).pipe(
      Effect.map(({ id }) => id),
      Effect.option,
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.middleware(cors, { global: true }),
          HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
          HttpRouter.add(
            "GET",
            "/api/todos",
            Effect.gen(function* () {
              const rows = yield* db
                .select()
                .from(Todos)
                .orderBy(asc(Todos.createdAt), asc(Todos.id));
              return yield* HttpServerResponse.json(
                Array.map(rows, toWireTodo),
              ).pipe(Effect.orDie);
            }).pipe(
              // Database failures are defects (same stance as the chat
              // starter's persistence service): the router answers 500.
              Effect.orDie,
            ),
          ),
          HttpRouter.add(
            "POST",
            "/api/todos",
            Effect.gen(function* () {
              const maybeBody = yield* HttpServerRequest.schemaBodyJson(
                CreateTodoRequest,
              ).pipe(Effect.option);
              if (Option.isNone(maybeBody)) {
                return HttpServerResponse.text("Expected { title: string }", {
                  status: 400,
                });
              }
              const title = maybeBody.value.title.trim();
              if (title.length === 0 || title.length > MAX_TODO_TITLE_LENGTH) {
                return HttpServerResponse.text(
                  `Title must be 1–${MAX_TODO_TITLE_LENGTH} characters.`,
                  { status: 422 },
                );
              }
              const rows = yield* db
                .insert(Todos)
                .values({ id: crypto.randomUUID(), title })
                .returning();
              return yield* HttpServerResponse.json(toWireTodo(rows[0]!), {
                status: 201,
              }).pipe(Effect.orDie);
            }).pipe(
              // Database failures are defects (same stance as the chat
              // starter's persistence service): the router answers 500.
              Effect.orDie,
            ),
          ),
          HttpRouter.add(
            "PATCH",
            "/api/todos/:id",
            Effect.gen(function* () {
              const maybeId = yield* todoIdParam;
              if (Option.isNone(maybeId)) return notFound;
              const maybeBody = yield* HttpServerRequest.schemaBodyJson(
                UpdateTodoRequest,
              ).pipe(Effect.option);
              if (Option.isNone(maybeBody)) {
                return HttpServerResponse.text(
                  "Expected { completed: boolean }",
                  { status: 400 },
                );
              }
              const rows = yield* db
                .update(Todos)
                .set({ completed: maybeBody.value.completed })
                .where(eq(Todos.id, maybeId.value))
                .returning();
              const row = rows[0];
              if (row === undefined) return notFound;
              return yield* HttpServerResponse.json(toWireTodo(row)).pipe(
                Effect.orDie,
              );
            }).pipe(
              // Database failures are defects (same stance as the chat
              // starter's persistence service): the router answers 500.
              Effect.orDie,
            ),
          ),
          HttpRouter.add(
            "DELETE",
            "/api/todos/:id",
            Effect.gen(function* () {
              const maybeId = yield* todoIdParam;
              if (Option.isNone(maybeId)) return notFound;
              const rows = yield* db
                .delete(Todos)
                .where(eq(Todos.id, maybeId.value))
                .returning({ id: Todos.id });
              const row = rows[0];
              if (row === undefined) return notFound;
              return yield* HttpServerResponse.json({ id: row.id }).pipe(
                Effect.orDie,
              );
            }).pipe(
              // Database failures are defects (same stance as the chat
              // starter's persistence service): the router answers 500.
              Effect.orDie,
            ),
          ),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
    // `Layer.fresh` for the same reason as in the starter's other workers:
    // the layer build is memoized globally and captures its host worker.
  }).pipe(Effect.provide(Layer.fresh(Cloudflare.Hyperdrive.ConnectBinding))),
);
