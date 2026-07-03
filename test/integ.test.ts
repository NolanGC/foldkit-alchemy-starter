import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BackendClient } from "../backend/src/Client.ts";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!process.env.CI)(destroy(Stack));

const { getWhenReady } = Test;

const clientFor = (baseUrl: string) =>
  BackendClient(baseUrl).pipe(Effect.provide(FetchHttpClient.layer));

test(
  "stack exposes frontend, backend, hyperdrive, and neon branch ids",
  Effect.gen(function* () {
    const { websiteUrl, backendUrl, branchId, hyperdriveId } = yield* stack;

    expect(websiteUrl).toBeString();
    expect(backendUrl).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

test(
  "backend lists seeded posts and creates a post",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* getWhenReady(`${backendUrl.replace(/\/+$/, "")}/api/posts`);

    const client = yield* clientFor(backendUrl);
    const initial = yield* client.Blog.listBlogData();

    expect(initial.users.length).toBeGreaterThan(0);
    expect(initial.posts.length).toBeGreaterThan(0);

    const selectedUser = initial.users[0]!;
    const created = yield* client.Blog.createPost({
      payload: {
        userId: selectedUser.id,
        title: "Integration test post",
        body: "Created through the typed HttpApi client.",
      },
    });

    expect(created.id).toBeNumber();
    expect(created.title).toBe("Integration test post");
    expect(created.body).toBe("Created through the typed HttpApi client.");
    expect(created.user.id).toBe(selectedUser.id);
  }),
  { timeout: 120_000 },
);

test(
  "backend handles repeated post list queries",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const client = yield* clientFor(backendUrl);

    yield* client.Blog.listBlogData().pipe(
      Effect.tap((data) => Effect.sync(() => expect(data.posts).toBeArray())),
      Effect.zip(
        Effect.sync(() => Math.floor(Math.random() * 401) + 100).pipe(
          Effect.flatMap((ms) => Effect.sleep(Duration.millis(ms))),
        ),
      ),
      Effect.repeat(Schedule.recurs(9)),
    );
  }),
  { timeout: 120_000 },
);
