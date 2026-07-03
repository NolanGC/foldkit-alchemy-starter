import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { asc, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Hyperdrive } from "./Db.ts";
import { BackendApi } from "./Spec.ts";
import { Posts, relations, Users } from "./schema.ts";

export default class Service extends Cloudflare.Worker<Service>()(
  "Service",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString, {
      relations,
    });

    const listData = Effect.gen(function* () {
      const users = yield* db.select().from(Users).orderBy(asc(Users.name));
      const posts = yield* db.query.Posts.findMany({
        with: { user: true },
        orderBy: (posts, { desc }) => [desc(posts.createdAt)],
      });
      type PostWithUser = (typeof posts)[number] & {
        user: NonNullable<(typeof posts)[number]["user"]>;
      };
      const postsWithUsers = posts.filter(
        (post): post is PostWithUser => post.user !== null,
      );

      return {
        users,
        posts: postsWithUsers,
      };
    });

    const blogGroup = HttpApiBuilder.group(BackendApi, "Blog", (handlers) =>
      handlers
        .handle("listBlogData", () => listData.pipe(Effect.orDie))
        .handle("createPost", ({ payload }) =>
          Effect.gen(function* () {
            const [user] = yield* db
              .select()
              .from(Users)
              .where(eq(Users.id, payload.userId))
              .limit(1);

            if (!user) {
              return yield* Effect.die(`Unknown user ${payload.userId}`);
            }

            const [post] = yield* db
              .insert(Posts)
              .values({
                userId: payload.userId,
                title: payload.title.trim(),
                body: payload.body.trim(),
              })
              .returning();

            return { ...post!, user };
          }).pipe(Effect.orDie),
        ),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(BackendApi).pipe(
          Layer.provide(blogGroup),
          Layer.provide([HttpPlatform.layer, Etag.layer]),
          Layer.provide(
            HttpRouter.cors({
              allowedOrigins: ["*"],
              allowedMethods: ["GET", "POST", "OPTIONS"],
              allowedHeaders: ["Content-Type", "b3", "traceparent"],
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Hyperdrive.ConnectBinding))),
) {}
