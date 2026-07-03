import { BackendClient } from "@foldkit/backend/Client";
import {
  BlogData as BlogDataSchema,
  Post as PostSchema,
  type BlogData,
  type Post,
} from "@foldkit/backend";
import { Button, Input, Select, Textarea } from "@foldkit/ui";
import { Match as M, Schema as S } from "effect";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Command, Runtime } from "foldkit";
import { type Document, type Html, html } from "foldkit/html";
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

export const Message = S.Union([
  ClickedRefresh,
  UpdatedSelectedUser,
  UpdatedTitle,
  UpdatedBody,
  SubmittedPostForm,
  SucceededLoadBlogData,
  FailedLoadBlogData,
  SucceededCreatePost,
  FailedCreatePost,
]);
export type Message = typeof Message.Type;

type UpdateResult = readonly [
  Model,
  ReadonlyArray<Command.Command<Message>>,
];

// UPDATE

export const update = (model: Model, message: Message): UpdateResult =>
  M.value(message).pipe(
    M.withReturnType<UpdateResult>(),
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
        const title = model.title.trim();
        const body = model.body.trim();
        const userId = Number(model.selectedUserId);

        if (
          model.isSaving ||
          model.blog._tag !== "BlogLoaded" ||
          title === "" ||
          body === "" ||
          !Number.isFinite(userId)
        ) {
          return [
            evo(model, {
              saveError: () =>
                title === "" || body === ""
                  ? "Title and body are required."
                  : model.saveError,
            }),
            [],
          ];
        }

        return [
          evo(model, {
            isSaving: () => true,
            saveError: () => "",
          }),
          [CreatePost({ userId, title, body })],
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
    }),
  );

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  {
    blog: BlogLoading(),
    selectedUserId: "",
    title: "",
    body: "",
    isSaving: false,
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
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
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
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
  ),
);

// VIEW

export const view = (model: Model): Document => {
  const h = html<Message>();

  return {
    title: "Posts",
    body: h.main(
      [h.Class("shell")],
      [
        h.section(
          [h.Class("toolbar")],
          [
            h.div([], [
              h.p([h.Class("eyebrow")], ["Alchemy + Foldkit + Neon + Hyperdrive"]),
              h.h1([], ["Posts"]),
            ]),
            Button.view<Message>({
              onClick: ClickedRefresh(),
              toView: (attributes) =>
                h.button([...attributes.button], ["Refresh"]),
            }),
          ],
        ),

        M.value(model.blog).pipe(
          M.tagsExhaustive({
            BlogLoading: () => h.div([h.Class("empty")], ["Loading posts..."]),
            BlogFailed: ({ error }) => h.div([h.Class("error")], [error]),
            BlogLoaded: ({ data }) => blogView(model, data),
          }),
        ),
      ],
    ),
  };
};

const blogView = (model: Model, data: BlogData): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("layout")],
    [
      composerView(model, data),
      h.div(
        [h.Class("feed")],
        data.posts.length === 0
          ? [h.div([h.Class("empty")], ["No posts yet."])]
          : data.posts.map(postView),
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
    [h.Class("composer"), h.OnSubmit(SubmittedPostForm())],
    [
      h.h2([], ["Create post"]),
      Select.view<Message>({
        id: "author",
        value: model.selectedUserId,
        onChange: (userId) => UpdatedSelectedUser({ userId }),
        isDisabled: model.isSaving || data.users.length === 0,
        toView: (attributes) =>
          h.label(
            [],
            [
              h.span([...attributes.label], ["Author"]),
              h.select(
                [...attributes.select],
                data.users.length === 0
                  ? [h.option([h.Value("")], ["No users"])]
                  : data.users.map((user) =>
                      h.option([h.Value(user.id.toString())], [user.name]),
                    ),
              ),
              h.span([...attributes.description], ["Select the post author."]),
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
          h.label(
            [],
            [
              h.span([...attributes.label], ["Title"]),
              h.input([...attributes.input]),
              h.span([...attributes.description], ["Post title."]),
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
          h.label(
            [],
            [
              h.span([...attributes.label], ["Body"]),
              h.textarea([...attributes.textarea], []),
              h.span([...attributes.description], ["Post body."]),
            ],
          ),
      }),
      Button.view<Message>({
        type: "submit",
        isDisabled: !canSubmit,
        toView: (attributes) =>
          h.button(
            [...attributes.button],
            [model.isSaving ? "Creating..." : "Create post"],
          ),
      }),
      model.saveError === ""
        ? h.empty
        : h.div([h.Class("error")], [model.saveError]),
    ],
  );
};

const postView = (post: Post): Html => {
  const h = html<Message>();

  return h.article(
    [h.Class("post"), h.Key(post.id.toString())],
    [
      h.div(
        [h.Class("postHeader")],
        [h.h2([], [post.title]), h.span([], [post.user.name])],
      ),
      h.p([], [post.body]),
    ],
  );
};
