import { Scene } from "foldkit";
import { describe, test } from "vitest";

import {
  BlogLoaded,
  CreatePost,
  DeletePost,
  SucceededDeletePost,
  SucceededCreatePost,
  update,
  view,
  type Model,
} from "./main";
import { Chat } from "./page";
import { ChatRoute, PostsRoute } from "./route";

const ada = {
  id: 1,
  email: "ada@example.com",
  name: "Ada Lovelace",
  createdAt: "2026-07-03T00:00:00.000Z",
};

const grace = {
  id: 2,
  email: "grace@example.com",
  name: "Grace Hopper",
  createdAt: "2026-07-03T00:00:00.000Z",
};

const firstPost = {
  id: 10,
  userId: ada.id,
  title: "Seed post",
  body: "This came from seed data.",
  createdAt: "2026-07-03T00:00:00.000Z",
  user: ada,
};

const createdPost = {
  id: 11,
  userId: grace.id,
  title: "New post",
  body: "Created from the Foldkit form.",
  createdAt: "2026-07-03T00:01:00.000Z",
  user: grace,
};

const loadedModel: Model = {
  route: PostsRoute(),
  chatPage: Chat.init("general"),
  blog: BlogLoaded({
    data: {
      users: [ada, grace],
      posts: [firstPost],
    },
  }),
  selectedUserId: ada.id.toString(),
  title: "",
  body: "",
  isSaving: false,
  deletingPostIds: [],
  saveError: "",
};

describe("view", () => {
  test("loaded posts render with the composer", () => {
    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.expect(Scene.role("heading", { name: "Posts" })).toExist(),
      Scene.expect(Scene.text("Seed post")).toExist(),
      Scene.expect(Scene.text("Ada Lovelace")).toExist(),
      Scene.expect(
        Scene.role("button", { name: "Create post" }),
      ).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Delete" })).toExist(),
    );
  });

  test("creating a post dispatches the backend command and renders the result", () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: "New post",
      body: "Created from the Foldkit form.",
    });

    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.change(Scene.label("Author"), grace.id.toString()),
      Scene.type(Scene.label("Title"), "New post"),
      Scene.type(Scene.label("Body"), "Created from the Foldkit form."),
      Scene.click(Scene.role("button", { name: "Create post" })),
      Scene.Command.expectExact(createPostCommand),
      Scene.Command.resolve(
        createPostCommand,
        SucceededCreatePost({ post: createdPost }),
      ),
      Scene.expect(Scene.text("New post")).toExist(),
      Scene.expect(Scene.text("Grace Hopper")).toExist(),
    );
  });

  test("deleting a post dispatches the backend command and removes it", () => {
    const deletePostCommand = DeletePost({ postId: firstPost.id });

    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
      Scene.click(Scene.role("button", { name: "Delete" })),
      Scene.Command.expectExact(deletePostCommand),
      Scene.Command.resolve(
        deletePostCommand,
        SucceededDeletePost({ postId: firstPost.id }),
      ),
      Scene.expect(Scene.text("Seed post")).toBeAbsent(),
    );
  });

  test("chat route renders a message column and centered textbox", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...loadedModel,
        route: ChatRoute({ roomId: "general" }),
        chatPage: {
          ...loadedModel.chatPage,
          connection: Chat.ConnectionConnected(),
        },
      }),
      Scene.expect(Scene.role("link", { name: "Posts" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Chat" })).toExist(),
      Scene.expect(Scene.text("Room: general")).toExist(),
      Scene.expect(Scene.text("No messages yet.")).toExist(),
      Scene.expect(Scene.label("Message")).toExist(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
    );
  });
});
