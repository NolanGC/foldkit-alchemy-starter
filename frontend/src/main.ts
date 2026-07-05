import {
  BlogData as BlogDataSchema,
  Post as PostSchema,
  type BlogData,
  type Post,
} from "@foldkit/backend";
import { BackendClient } from "@foldkit/backend/Client";
import { Button, Input, Select, Textarea } from "@foldkit/ui";
import { Array, Effect, Match as M, Option, Schema as S } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Command, ManagedResource, Runtime, Subscription } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { Chat } from "./page";
import { AppRoute, chatRouter, postsRouter, urlToAppRoute } from "./route";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

// MODEL

export const BlogLoading = ts("BlogLoading");
export const BlogLoaded = ts("BlogLoaded", { data: BlogDataSchema });
export const BlogFailed = ts("BlogFailed", { error: S.String });

const BlogState = S.Union([BlogLoading, BlogLoaded, BlogFailed]);

export const Model = S.Struct({
  route: AppRoute,
  chatPage: Chat.Model,
  blog: BlogState,
  selectedUserId: S.String,
  title: S.String,
  body: S.String,
  isSaving: S.Boolean,
  deletingPostIds: S.Array(S.Number),
  maybeActionError: S.Option(S.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const CompletedNavigateInternal = m("CompletedNavigateInternal");
export const CompletedLoadExternal = m("CompletedLoadExternal");
export const ClickedLink = m("ClickedLink", {
  request: UrlRequest,
});
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const GotChatMessage = m("GotChatMessage", {
  message: Chat.Message,
});
export const ClickedRefresh = m("ClickedRefresh");
export const UpdatedSelectedUser = m("UpdatedSelectedUser", {
  userId: S.String,
});
export const UpdatedTitle = m("UpdatedTitle", { value: S.String });
export const UpdatedBody = m("UpdatedBody", { value: S.String });
export const SubmittedPostForm = m("SubmittedPostForm");
export const ClickedDeletePost = m("ClickedDeletePost", {
  postId: S.Number,
});
export const SucceededLoadBlogData = m("SucceededLoadBlogData", {
  data: BlogDataSchema,
});
export const FailedLoadBlogData = m("FailedLoadBlogData", {
  error: S.String,
});
export const SucceededCreatePost = m("SucceededCreatePost", {
  post: PostSchema,
});
export const FailedCreatePost = m("FailedCreatePost", { error: S.String });
export const SucceededDeletePost = m("SucceededDeletePost", {
  postId: S.Number,
});
export const FailedDeletePost = m("FailedDeletePost", {
  postId: S.Number,
  error: S.String,
});

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
  GotChatMessage,
  ClickedRefresh,
  UpdatedSelectedUser,
  UpdatedTitle,
  UpdatedBody,
  SubmittedPostForm,
  ClickedDeletePost,
  SucceededLoadBlogData,
  FailedLoadBlogData,
  SucceededCreatePost,
  FailedCreatePost,
  SucceededDeletePost,
  FailedDeletePost,
]);
export type Message = typeof Message.Type;

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const route = urlToAppRoute(url);

  return [
    {
      route,
      chatPage: Chat.init(route._tag === "Chat" ? route.roomId : "general"),
      blog: BlogLoading(),
      selectedUserId: "",
      title: "",
      body: "",
      isSaving: false,
      deletingPostIds: [],
      maybeActionError: Option.none(),
    },
    [FetchBlogData()],
  ];
};

// COMMAND

const backend = BackendClient(API_URL);

const NavigateInternal = Command.define(
  "NavigateInternal",
  { url: S.String },
  CompletedNavigateInternal,
)(({ url }) => pushUrl(url).pipe(Effect.as(CompletedNavigateInternal())));

const LoadExternal = Command.define(
  "LoadExternal",
  { href: S.String },
  CompletedLoadExternal,
)(({ href }) => load(href).pipe(Effect.as(CompletedLoadExternal())));

export const FetchBlogData = Command.define(
  "FetchBlogData",
  SucceededLoadBlogData,
  FailedLoadBlogData,
)(
  backend.pipe(
    Effect.flatMap((api) => api.Blog.listBlogData()),
    Effect.map((data) => SucceededLoadBlogData({ data })),
    Effect.catch((error) =>
      Effect.succeed(FailedLoadBlogData({ error: String(error) })),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
);

export const CreatePost = Command.define(
  "CreatePost",
  {
    userId: S.Number,
    title: S.String,
    body: S.String,
  },
  SucceededCreatePost,
  FailedCreatePost,
)((payload) =>
  backend.pipe(
    Effect.flatMap((api) => api.Blog.createPost({ payload })),
    Effect.map((post) => SucceededCreatePost({ post })),
    Effect.catch((error) =>
      Effect.succeed(FailedCreatePost({ error: String(error) })),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
);

export const DeletePost = Command.define(
  "DeletePost",
  {
    postId: S.Number,
  },
  SucceededDeletePost,
  FailedDeletePost,
)(({ postId }) =>
  backend.pipe(
    Effect.flatMap((api) => api.Blog.deletePost({ params: { id: postId } })),
    Effect.map(() => SucceededDeletePost({ postId })),
    Effect.catch((error) =>
      Effect.succeed(FailedDeletePost({ postId, error: String(error) })),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
);

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, Chat.ChatSocketService>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

const whenSubmittedPostForm = (model: Model): UpdateReturn => {
  if (model.blog._tag !== "BlogLoaded" || model.isSaving) {
    return [model, []];
  }

  const title = model.title.trim();
  const body = model.body.trim();

  if (title === "" || body === "") {
    return [
      evo(model, {
        maybeActionError: () => Option.some("Title and body are required."),
      }),
      [],
    ];
  }

  const userId = Number(model.selectedUserId);
  const author = model.blog.data.users.find((user) => user.id === userId);

  if (author === undefined) {
    return [
      evo(model, {
        maybeActionError: () => Option.some("Select an author."),
      }),
      [],
    ];
  }

  return [
    evo(model, {
      isSaving: () => true,
      maybeActionError: () => Option.none(),
    }),
    [CreatePost({ userId: author.id, title, body })],
  ];
};

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      CompletedNavigateInternal: () => [model, []],
      CompletedLoadExternal: () => [model, []],

      ClickedLink: ({ request }) =>
        M.value(request).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            Internal: ({ url }) => [
              model,
              [NavigateInternal({ url: urlToString(url) })],
            ],
            External: ({ href }) => [model, [LoadExternal({ href })]],
          }),
        ),

      ChangedUrl: ({ url }) => {
        const route = urlToAppRoute(url);

        return [
          evo(model, {
            route: () => route,
            chatPage: (chatPage) =>
              route._tag === "Chat"
                ? Chat.connect(chatPage, route.roomId)
                : chatPage,
          }),
          [],
        ];
      },

      GotChatMessage: ({ message }) => {
        const [chatPage, commands] = Chat.update(model.chatPage, message);

        return [
          evo(model, { chatPage: () => chatPage }),
          Command.mapMessages(commands, (message) =>
            GotChatMessage({ message }),
          ),
        ];
      },

      ClickedRefresh: () => [
        evo(model, {
          blog: () => BlogLoading(),
          maybeActionError: () => Option.none(),
        }),
        [FetchBlogData()],
      ],

      UpdatedSelectedUser: ({ userId }) => [
        evo(model, { selectedUserId: () => userId }),
        [],
      ],

      UpdatedTitle: ({ value }) => [
        evo(model, {
          title: () => value,
          maybeActionError: () => Option.none(),
        }),
        [],
      ],

      UpdatedBody: ({ value }) => [
        evo(model, {
          body: () => value,
          maybeActionError: () => Option.none(),
        }),
        [],
      ],

      SubmittedPostForm: () => whenSubmittedPostForm(model),

      ClickedDeletePost: ({ postId }) => {
        if (
          model.blog._tag !== "BlogLoaded" ||
          model.deletingPostIds.includes(postId)
        ) {
          return [model, []];
        }

        return [
          evo(model, {
            deletingPostIds: (postIds) => [...postIds, postId],
            maybeActionError: () => Option.none(),
          }),
          [DeletePost({ postId })],
        ];
      },

      SucceededLoadBlogData: ({ data }) => [
        evo(model, {
          blog: () => BlogLoaded({ data }),
          selectedUserId: (current) =>
            data.users.some((user) => user.id.toString() === current)
              ? current
              : (data.users[0]?.id.toString() ?? ""),
        }),
        [],
      ],

      FailedLoadBlogData: ({ error }) => [
        evo(model, {
          blog: () => BlogFailed({ error }),
        }),
        [],
      ],

      SucceededCreatePost: ({ post }) => [
        evo(model, {
          blog: (blog) =>
            blog._tag === "BlogLoaded"
              ? BlogLoaded({
                  data: {
                    users: blog.data.users,
                    posts: [post, ...blog.data.posts],
                  },
                })
              : blog,
          title: () => "",
          body: () => "",
          isSaving: () => false,
          maybeActionError: () => Option.none(),
        }),
        [],
      ],

      FailedCreatePost: ({ error }) => [
        evo(model, {
          isSaving: () => false,
          maybeActionError: () => Option.some(error),
        }),
        [],
      ],

      SucceededDeletePost: ({ postId }) => [
        evo(model, {
          blog: (blog) =>
            blog._tag === "BlogLoaded"
              ? BlogLoaded({
                  data: {
                    users: blog.data.users,
                    posts: blog.data.posts.filter((post) => post.id !== postId),
                  },
                })
              : blog,
          deletingPostIds: (postIds) =>
            postIds.filter((currentPostId) => currentPostId !== postId),
          maybeActionError: () => Option.none(),
        }),
        [],
      ],

      FailedDeletePost: ({ postId, error }) => [
        evo(model, {
          deletingPostIds: (postIds) =>
            postIds.filter((currentPostId) => currentPostId !== postId),
          maybeActionError: () => Option.some(error),
        }),
        [],
      ],
    }),
  );

// MANAGED RESOURCES

export const managedResources = ManagedResource.lift(Chat.managedResources)<
  Model,
  Message
>({
  toChildModel: (model) =>
    model.route._tag === "Chat" ? Option.some(model.chatPage) : Option.none(),
  toParentMessage: (message) => GotChatMessage({ message }),
});

// SUBSCRIPTIONS

export const subscriptions = Subscription.lift(Chat.subscriptions)<
  Model,
  Message
>({
  toChildModel: (model) => model.chatPage,
  toParentMessage: (message) => GotChatMessage({ message }),
});

// VIEW

const navigationView = (currentRoute: AppRoute): Html => {
  const h = html<Message>();

  const linkClassName = (isActive: boolean) =>
    `px-3 py-2 text-sm font-medium ${isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;

  return h.nav(
    [h.Class("border-b border-neutral-900")],
    [
      h.ul(
        [h.Class("mx-auto flex max-w-5xl gap-2 px-4 py-3")],
        [
          h.li(
            [],
            [
              h.a(
                [
                  h.Href(postsRouter()),
                  h.Class(linkClassName(currentRoute._tag === "Posts")),
                ],
                ["Posts"],
              ),
            ],
          ),
          h.li(
            [],
            [
              h.a(
                [
                  h.Href(chatRouter({ roomId: "general" })),
                  h.Class(linkClassName(currentRoute._tag === "Chat")),
                ],
                ["Chat"],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

export const view = (model: Model): Document => {
  const h = html<Message>();

  const routeContent = M.value(model.route).pipe(
    M.tagsExhaustive({
      Posts: () => postsView(model),
      Chat: () =>
        h.submodel({
          slotId: "chat",
          model: model.chatPage,
          view: Chat.view,
          toParentMessage: (message) => GotChatMessage({ message }),
        }),
      NotFound: ({ path }) => notFoundView(path),
    }),
  );

  return {
    title: routeTitle(model.route),
    body: h.div(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [
        navigationView(model.route),
        h.keyed("main")(routeKey(model.route), [], [routeContent]),
      ],
    ),
  };
};

const postsView = (model: Model): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.header(
        [h.Class("mb-8 flex items-end justify-between gap-4")],
        [
          h.div(
            [],
            [
              h.p(
                [h.Class("mb-1 text-sm font-bold uppercase text-neutral-400")],
                ["Alchemy + Foldkit + Neon"],
              ),
              h.h1([h.Class("text-4xl font-bold leading-tight")], ["Posts"]),
            ],
          ),
          Button.view<Message>({
            onClick: ClickedRefresh(),
            toView: (attributes) =>
              h.button(
                [
                  ...attributes.button,
                  h.Class(
                    "border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
                  ),
                ],
                ["Refresh"],
              ),
          }),
        ],
      ),

      M.value(model.blog).pipe(
        M.tagsExhaustive({
          BlogLoading: () =>
            h.div(
              [
                h.Class(
                  "border border-neutral-800 bg-neutral-900 p-4 text-neutral-400",
                ),
              ],
              ["Loading posts..."],
            ),
          BlogFailed: ({ error }) =>
            h.div(
              [
                h.Class(
                  "border border-neutral-800 bg-neutral-900 p-4 text-neutral-300",
                ),
                h.Role("alert"),
              ],
              [error],
            ),
          BlogLoaded: ({ data }) => blogView(model, data),
        }),
      ),
    ],
  );
};

const notFoundView = (path: string): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.div(
        [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
        [
          h.h1([h.Class("text-2xl font-bold")], ["Page not found"]),
          h.p([h.Class("mt-2 text-neutral-400")], [`No route for ${path}.`]),
          h.a(
            [
              h.Href(postsRouter()),
              h.Class(
                "mt-4 inline-block border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
              ),
            ],
            ["Back to posts"],
          ),
        ],
      ),
    ],
  );
};

const routeTitle = (route: AppRoute): string =>
  M.value(route).pipe(
    M.tag("Posts", () => "Posts"),
    M.tag("Chat", ({ roomId }) => `Chat: ${roomId}`),
    M.tag("NotFound", () => "Not Found"),
    M.exhaustive,
  );

const routeKey = (route: AppRoute): string =>
  M.value(route).pipe(
    M.tag("Posts", () => "Posts"),
    M.tag("Chat", ({ roomId }) => `Chat:${roomId}`),
    M.tag("NotFound", ({ path }) => `NotFound:${path}`),
    M.exhaustive,
  );

const blogView = (model: Model, data: BlogData): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("grid items-start gap-6 md:grid-cols-[340px_1fr]")],
    [
      composerView(model, data),
      h.div(
        [h.Class("grid gap-4")],
        Array.match(data.posts, {
          onEmpty: () => [
            h.div(
              [
                h.Class(
                  "border border-neutral-800 bg-neutral-900 p-4 text-neutral-400",
                ),
              ],
              ["No posts yet."],
            ),
          ],
          onNonEmpty: (posts) =>
            Array.map(posts, (post) => postView(model, post)),
        }),
      ),
    ],
  );
};

const composerView = (model: Model, data: BlogData): Html => {
  const h = html<Message>();
  const canSubmit =
    !model.isSaving &&
    Array.isReadonlyArrayNonEmpty(data.users) &&
    model.title.trim() !== "" &&
    model.body.trim() !== "";

  return h.form(
    [
      h.Class(
        "grid gap-4 border border-neutral-800 bg-neutral-900 p-4 md:sticky md:top-6",
      ),
      h.OnSubmit(SubmittedPostForm()),
    ],
    [
      h.h2([h.Class("text-lg font-bold text-neutral-200")], ["Create post"]),
      Select.view<Message>({
        id: "author",
        value: model.selectedUserId,
        onChange: (userId) => UpdatedSelectedUser({ userId }),
        isDisabled: model.isSaving || Array.isReadonlyArrayEmpty(data.users),
        toView: (attributes) =>
          h.div(
            [h.Class("grid gap-1")],
            [
              h.label(
                [...attributes.label, h.Class("text-sm font-bold")],
                ["Author"],
              ),
              h.select(
                [
                  ...attributes.select,
                  h.Class(
                    "w-full border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100",
                  ),
                ],
                Array.match(data.users, {
                  onEmpty: () => [h.option([h.Value("")], ["No users"])],
                  onNonEmpty: (users) =>
                    Array.map(users, (user) =>
                      h.option([h.Value(user.id.toString())], [user.name]),
                    ),
                }),
              ),
            ],
          ),
      }),
      Input.view<Message>({
        id: "title",
        value: model.title,
        placeholder: "A short title",
        onInput: (value) => UpdatedTitle({ value }),
        isDisabled: model.isSaving,
        toView: (attributes) =>
          h.div(
            [h.Class("grid gap-1")],
            [
              h.label(
                [...attributes.label, h.Class("text-sm font-bold")],
                ["Title"],
              ),
              h.input([
                ...attributes.input,
                h.Class(
                  "w-full border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100",
                ),
              ]),
            ],
          ),
      }),
      Textarea.view<Message>({
        id: "body",
        value: model.body,
        placeholder: "Write the post body",
        rows: 6,
        onInput: (value) => UpdatedBody({ value }),
        isDisabled: model.isSaving,
        toView: (attributes) =>
          h.div(
            [h.Class("grid gap-1")],
            [
              h.label(
                [...attributes.label, h.Class("text-sm font-bold")],
                ["Body"],
              ),
              h.textarea(
                [
                  ...attributes.textarea,
                  h.Class(
                    "w-full border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100",
                  ),
                ],
                [],
              ),
            ],
          ),
      }),
      Button.view<Message>({
        type: "submit",
        isDisabled: !canSubmit,
        toView: (attributes) =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                "border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
              ),
            ],
            [model.isSaving ? "Creating..." : "Create post"],
          ),
      }),
      Option.match(model.maybeActionError, {
        onNone: () => h.empty,
        onSome: (error) =>
          h.div(
            [
              h.Class(
                "border border-neutral-800 bg-neutral-900 p-4 text-neutral-300",
              ),
              h.Role("alert"),
            ],
            [error],
          ),
      }),
    ],
  );
};

const postView = (model: Model, post: Post): Html => {
  const h = html<Message>();
  const isDeleting = model.deletingPostIds.includes(post.id);

  return h.keyed("article")(
    post.id.toString(),
    [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-4")],
        [
          h.div(
            [],
            [
              h.h2([h.Class("text-xl font-bold leading-snug")], [post.title]),
              h.span(
                [h.Class("text-sm font-bold text-neutral-400")],
                [post.user.name],
              ),
            ],
          ),
          Button.view<Message>({
            onClick: ClickedDeletePost({ postId: post.id }),
            isDisabled: isDeleting,
            toView: (attributes) =>
              h.button(
                [
                  ...attributes.button,
                  h.Class(
                    "border border-neutral-700 px-3 py-1 text-sm font-medium text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-50",
                  ),
                ],
                [isDeleting ? "Deleting..." : "Delete"],
              ),
          }),
        ],
      ),
      h.p([h.Class("mt-3 leading-relaxed text-neutral-300")], [post.body]),
    ],
  );
};
