// Integration test against REAL infrastructure: deploys the full stack
// (Postgres branch + Drizzle migrations, Hyperdrive, both Cloudflare
// workers) before the tests and destroys it after.
//
// Covers:
// - Deploy and teardown of the whole stack, including adoption of resources
//   stranded by earlier failed runs (`adopt: true`).
// - Stack outputs exist (website/api URLs, database branch id, Hyperdrive id).
// - Full CRUD through the open API: create (with server-side title trimming
//   and 422 on an empty title), list, toggle, delete, and 404 for unknown
//   ids.
//
// Does NOT cover:
// - The Website worker beyond deploying it, and none of the frontend.
// - Local dev mode (`alchemy dev`); the test always deploys to the cloud.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// Opt-in guard: a bare `bun test` must never deploy real infrastructure.
// `bun run test:integ` sets INTEG=1.
if (process.env.INTEG !== "1") {
  console.log(
    "Skipping integration tests — run `bun run test:integ` (deploys real infrastructure).",
  );
  process.exit(0);
}

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
    Planetscale.providers(),
  ),
  // Local state on disk: each run deploys and destroys its own stack.
  state: Alchemy.localState(),
  // Resource names are deterministic per stage, so anything a past run
  // stranded (failed teardown, lost local state) collides with the next
  // create. Adopt instead of failing: the run takes ownership and the
  // teardown finally deletes it.
  adopt: true,
});

const stack = beforeAll(deploy(Stack));

// Teardown must not leave paid resources behind, so ride out transient API
// failures. Destroy plans from state, so a retry only deletes whatever is
// still standing.
afterAll(
  destroy(Stack).pipe(
    Effect.retry({ times: 3, schedule: Schedule.spaced("10 seconds") }),
  ),
);

const { getWhenReady } = Test;

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

// A freshly created Hyperdrive config takes a while to propagate to the
// edge; until then every DB-backed route 500s even though the worker itself
// answers (getWhenReady passes). `api` below throws on any 5xx, and only
// those failures are retried; 4xx and assertion failures are real bugs and
// surface immediately.
const isWarmupFailure = (error: unknown): boolean =>
  /failed \(5\d\d\)/.test(
    String(
      (error as { cause?: unknown }).cause ?? (error as { message?: unknown }),
    ),
  );

const retryWhileWarmingUp = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.retry({
      while: isWarmupFailure,
      times: 24,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

// Error bodies are plain text ("Todo not found"), success bodies JSON.
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const api = (
  apiUrl: string,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
  } = {},
) =>
  retryWhileWarmingUp(
    Effect.tryPromise(async (): Promise<ApiResponse> => {
      const method = options.method ?? "GET";
      const response = await fetch(new URL(path, apiUrl), {
        method,
        headers: {
          ...(options.body !== undefined && {
            "content-type": "application/json",
          }),
        },
        ...(options.body !== undefined && {
          body: JSON.stringify(options.body),
        }),
      });
      const text = await response.text();
      if (response.status >= 500) {
        throw new Error(
          `${method} ${path} failed (${response.status}): ${text}`,
        );
      }
      return {
        status: response.status,
        body: text === "" ? undefined : parseBody(text),
      };
    }),
  );

interface WireTodo {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

const todoIds = (body: unknown): ReadonlyArray<string> =>
  (body as ReadonlyArray<WireTodo>).map((todo) => todo.id);

test(
  "stack exposes frontend, api, hyperdrive, and database branch ids",
  Effect.gen(function* () {
    const { websiteUrl, apiUrl, branchId, hyperdriveId } = yield* stack;

    expect(websiteUrl).toBeString();
    expect(apiUrl).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

test(
  "todos support full CRUD without a session",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    yield* getWhenReady(apiUrl);

    // Create validates and trims the title server-side.
    const blank = yield* api(apiUrl, "/api/todos", {
      method: "POST",
      body: { title: "   " },
    });
    expect(blank.status).toBe(422);

    const title = `Ship the integration test ${crypto.randomUUID()}`;
    const created = yield* api(apiUrl, "/api/todos", {
      method: "POST",
      body: { title: `  ${title}  ` },
    });
    expect(created.status).toBe(201);
    const todo = created.body as WireTodo;
    expect(todo.title).toBe(title);
    expect(todo.completed).toBe(false);

    const list = yield* api(apiUrl, "/api/todos");
    expect(list.status).toBe(200);
    expect(todoIds(list.body)).toContain(todo.id);

    // Unknown (but well-formed) ids read as missing todos.
    const missing = yield* api(apiUrl, `/api/todos/${crypto.randomUUID()}`, {
      method: "PATCH",
      body: { completed: true },
    });
    expect(missing.status).toBe(404);

    const patched = yield* api(apiUrl, `/api/todos/${todo.id}`, {
      method: "PATCH",
      body: { completed: true },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as WireTodo).completed).toBe(true);

    const deleted = yield* api(apiUrl, `/api/todos/${todo.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const afterDelete = yield* api(apiUrl, "/api/todos");
    expect(todoIds(afterDelete.body)).not.toContain(todo.id);
  }),
  { timeout: 300_000 },
);
