import {
  BlogData as BlogDataSchema,
  Post as PostSchema,
  type BlogData,
  type Post,
} from "@foldkit/backend";
import { BackendClient } from "@foldkit/backend/Client";
import { Button, Input, Select, Textarea } from "@foldkit/ui";
import { Effect, Match as M, Schema as S } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Command, Runtime } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

// MODEL

export const BlogLoading = ts("BlogLoading");
export const BlogLoaded = ts("BlogLoaded", { data: BlogDataSchema });
export const BlogFailed = ts("BlogFailed", { error: S.String });

const BlogState = S.Union([BlogLoading, BlogLoaded, BlogFailed]);

export const Model = S.Struct({
  blog: BlogState,
  selectedUserId: S.String,
  title: S.String,
  body: S.String,
  isSaving: S.Boolean,
  deletingPostIds: S.Array(S.Number),
  saveError: S.String,
});
export type Model = typeof Model.Type;

// MESSAGE

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

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  {
    blog: BlogLoading(),
    selectedUserId: "",
    title: "",
    body: "",
    isSaving: false,
    deletingPostIds: [],
    saveError: "",
  },
  [FetchBlogData()],
];

// COMMAND

const backend = BackendClient(API_URL);

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

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      ClickedRefresh: () => [
        evo(model, {
          blog: () => BlogLoading(),
          saveError: () => "",
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
          saveError: () => "",
        }),
        [],
      ],

      UpdatedBody: ({ value }) => [
        evo(model, {
          body: () => value,
          saveError: () => "",
        }),
        [],
      ],

      SubmittedPostForm: () => {
        if (model.blog._tag !== "BlogLoaded" || model.isSaving) {
          return [model, []];
        }

        const title = model.title.trim();
        const body = model.body.trim();

        if (title === "" || body === "") {
          return [
            evo(model, {
              saveError: () => "Title and body are required.",
            }),
            [],
          ];
        }

        const userId = Number(model.selectedUserId);
        const author = model.blog.data.users.find((user) => user.id === userId);

        if (author === undefined) {
          return [
            evo(model, {
              saveError: () => "Select an author.",
            }),
            [],
          ];
        }

        return [
          evo(model, {
            isSaving: () => true,
            saveError: () => "",
          }),
          [CreatePost({ userId: author.id, title, body })],
        ];
      },

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
            saveError: () => "",
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
          saveError: () => "",
        }),
        [],
      ],

      FailedCreatePost: ({ error }) => [
        evo(model, {
          isSaving: () => false,
          saveError: () => error,
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
          saveError: () => "",
        }),
        [],
      ],

      FailedDeletePost: ({ postId, error }) => [
        evo(model, {
          deletingPostIds: (postIds) =>
            postIds.filter((currentPostId) => currentPostId !== postId),
          saveError: () => error,
        }),
        [],
      ],
    }),
  );

// VIEW

export const view = (model: Model): Document => {
  const h = html<Message>();

  return {
    title: "Posts",
    body: h.main(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [
        h.section(
          [h.Class("mx-auto max-w-5xl px-4 py-10")],
          [
            h.header(
              [h.Class("mb-8 flex items-end justify-between gap-4")],
              [
                h.div(
                  [],
                  [
                    h.p(
                      [
                        h.Class(
                          "mb-1 text-sm font-bold uppercase text-neutral-400",
                        ),
                      ],
                      ["Alchemy + Foldkit + Neon"],
                    ),
                    h.h1(
                      [h.Class("text-4xl font-bold leading-tight")],
                      ["Posts"],
                    ),
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
                    ],
                    [error],
                  ),
                BlogLoaded: ({ data }) => blogView(model, data),
              }),
            ),
          ],
        ),
      ],
    ),
  };
};

const blogView = (model: Model, data: BlogData): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("grid items-start gap-6 md:grid-cols-[340px_1fr]")],
    [
      composerView(model, data),
      h.div(
        [h.Class("grid gap-4")],
        data.posts.length === 0
          ? [
              h.div(
                [
                  h.Class(
                    "border border-neutral-800 bg-neutral-900 p-4 text-neutral-400",
                  ),
                ],
                ["No posts yet."],
              ),
            ]
          : data.posts.map((post) => postView(model, post)),
      ),
    ],
  );
};

const composerView = (model: Model, data: BlogData): Html => {
  const h = html<Message>();
  const canSubmit =
    !model.isSaving &&
    data.users.length > 0 &&
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
        isDisabled: model.isSaving || data.users.length === 0,
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
                data.users.length === 0
                  ? [h.option([h.Value("")], ["No users"])]
                  : data.users.map((user) =>
                      h.option([h.Value(user.id.toString())], [user.name]),
                    ),
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
      model.saveError === ""
        ? h.empty
        : h.div(
            [
              h.Class(
                "border border-neutral-800 bg-neutral-900 p-4 text-neutral-300",
              ),
            ],
            [model.saveError],
          ),
    ],
  );
};

const postView = (model: Model, post: Post): Html => {
  const h = html<Message>();
  const isDeleting = model.deletingPostIds.includes(post.id);

  return h.article(
    [
      h.Class("border border-neutral-800 bg-neutral-900 p-4"),
      h.Key(post.id.toString()),
    ],
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
