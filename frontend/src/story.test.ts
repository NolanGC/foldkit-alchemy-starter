import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";
import { DateTime, Option } from "effect";

import {
  BlogLoaded,
  ClickedRefresh,
  ClickedDeletePost,
  CreatePost,
  DeletePost,
  FailedDeletePost,
  FailedCreatePost,
  FetchBlogData,
  GotChatMessage,
  SubmittedPostForm,
  SucceededCreatePost,
  SucceededDeletePost,
  SucceededLoadBlogData,
  UpdatedBody,
  UpdatedSelectedUser,
  UpdatedTitle,
  init,
  update,
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

const blogData = {
  users: [ada, grace],
  posts: [firstPost],
};

const zonedNow = DateTime.makeZonedUnsafe(0, { timeZone: "UTC" });

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

const loadingModel: Model = {
  route: PostsRoute(),
  chatPage: Chat.init("general"),
  blog: { _tag: "BlogLoading" },
  selectedUserId: "",
  title: "",
  body: "",
  isSaving: false,
  deletingPostIds: [],
  maybeActionError: Option.none(),
};

const loadedModel: Model = {
  ...loadingModel,
  blog: BlogLoaded({ data: blogData }),
  selectedUserId: ada.id.toString(),
};

describe("update", () => {
  test("init starts loading blog data", () => {
    const [model, commands] = init(url("/"));

    expect(model.route._tag).toBe("Posts");
    expect(model.chatPage.roomId).toBe("general");
    expect(model.blog._tag).toBe("BlogLoading");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe(FetchBlogData.name);
  });

  test("init from a chat route captures the room id", () => {
    const [model, commands] = init(url("/chat/general"));

    expect(model.route).toEqual(ChatRoute({ roomId: "general" }));
    expect(model.chatPage.roomId).toBe("general");
    expect(model.chatPage.connection._tag).toBe("ConnectionConnecting");
    expect(commands).toHaveLength(1);
  });

  test("refresh loads data and selects the first user", () => {
    Story.story(
      update,
      Story.with(loadingModel),
      Story.message(ClickedRefresh()),
      Story.Command.expectExact(FetchBlogData),
      Story.Command.resolve(
        FetchBlogData,
        SucceededLoadBlogData({ data: blogData }),
      ),
      Story.model((model) => {
        expect(model.blog._tag).toBe("BlogLoaded");
        expect(model.selectedUserId).toBe(ada.id.toString());
      }),
    );
  });

  test("submitting a valid post dispatches CreatePost and prepends the result", () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: "New post",
      body: "Created from the Foldkit form.",
    });

    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(UpdatedSelectedUser({ userId: grace.id.toString() })),
      Story.Command.expectNone(),
      Story.message(UpdatedTitle({ value: "  New post  " })),
      Story.Command.expectNone(),
      Story.message(
        UpdatedBody({ value: "  Created from the Foldkit form.  " }),
      ),
      Story.Command.expectNone(),
      Story.message(SubmittedPostForm()),
      Story.Command.expectExact(createPostCommand),
      Story.Command.resolve(
        createPostCommand,
        SucceededCreatePost({ post: createdPost }),
      ),
      Story.model((model) => {
        expect(model.blog._tag).toBe("BlogLoaded");
        if (model.blog._tag === "BlogLoaded") {
          expect(model.blog.data.posts[0]).toEqual(createdPost);
        }
        expect(model.title).toBe("");
        expect(model.body).toBe("");
        expect(model.isSaving).toBe(false);
        expect(model.maybeActionError).toEqual(Option.none());
      }),
    );
  });

  test("empty form submission stays pure and records validation error", () => {
    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(SubmittedPostForm()),
      Story.Command.expectNone(),
      Story.model((model) => {
        expect(model.maybeActionError).toEqual(
          Option.some("Title and body are required."),
        );
      }),
    );
  });

  test("failed create keeps draft and stores error", () => {
    const createPostCommand = CreatePost({
      userId: grace.id,
      title: "New post",
      body: "Created from the Foldkit form.",
    });

    Story.story(
      update,
      Story.with({
        ...loadedModel,
        selectedUserId: grace.id.toString(),
        title: "New post",
        body: "Created from the Foldkit form.",
      }),
      Story.message(SubmittedPostForm()),
      Story.Command.expectHas(createPostCommand),
      Story.Command.resolve(
        createPostCommand,
        FailedCreatePost({ error: "Backend rejected the post." }),
      ),
      Story.model((model) => {
        expect(model.title).toBe("New post");
        expect(model.body).toBe("Created from the Foldkit form.");
        expect(model.isSaving).toBe(false);
        expect(model.maybeActionError).toEqual(
          Option.some("Backend rejected the post."),
        );
      }),
    );
  });

  test("deleting a post dispatches DeletePost and removes it", () => {
    const deletePostCommand = DeletePost({ postId: firstPost.id });

    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(ClickedDeletePost({ postId: firstPost.id })),
      Story.Command.expectExact(deletePostCommand),
      Story.Command.resolve(
        deletePostCommand,
        SucceededDeletePost({ postId: firstPost.id }),
      ),
      Story.model((model) => {
        expect(model.deletingPostIds).toEqual([]);
        expect(model.blog._tag).toBe("BlogLoaded");
        if (model.blog._tag === "BlogLoaded") {
          expect(model.blog.data.posts).toEqual([]);
        }
      }),
    );
  });

  test("failed delete leaves the post and records the error", () => {
    const deletePostCommand = DeletePost({ postId: firstPost.id });

    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(ClickedDeletePost({ postId: firstPost.id })),
      Story.Command.expectHas(deletePostCommand),
      Story.Command.resolve(
        deletePostCommand,
        FailedDeletePost({
          postId: firstPost.id,
          error: "Backend rejected delete.",
        }),
      ),
      Story.model((model) => {
        expect(model.deletingPostIds).toEqual([]);
        expect(model.maybeActionError).toEqual(
          Option.some("Backend rejected delete."),
        );
        expect(model.blog._tag).toBe("BlogLoaded");
        if (model.blog._tag === "BlogLoaded") {
          expect(model.blog.data.posts).toEqual([firstPost]);
        }
      }),
    );
  });

  test("chat messages are delegated into the chat page", () => {
    Story.story(
      update,
      Story.with({
        ...loadedModel,
        route: ChatRoute({ roomId: "general" }),
      }),
      Story.message(
        GotChatMessage({
          message: Chat.TimestampedMessage({
            text: "[user] hello",
            zoned: zonedNow,
          }),
        }),
      ),
      Story.model((model) => {
        expect(model.chatPage.messages).toEqual([
          { text: "[user] hello", zoned: zonedNow },
        ]);
      }),
    );
  });
});

describe("chat update", () => {
  const connectedChat = {
    ...Chat.init("general"),
    connection: Chat.ConnectionConnected(),
  };

  test("submitting a connected chat message sends and clears the input", () => {
    const sendMessageCommand = Chat.SendMessage({ text: "hello" });

    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, messageInput: "  hello  " }),
      Story.message(Chat.SubmittedMessage()),
      Story.Command.expectExact(sendMessageCommand),
      Story.Command.resolve(
        sendMessageCommand,
        Chat.SucceededSendMessage({ text: "hello" }),
      ),
      Story.model((model) => {
        expect(model.messageInput).toBe("");
      }),
    );
  });

  test("empty chat submissions are ignored", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, messageInput: "   " }),
      Story.message(Chat.SubmittedMessage()),
      Story.Command.expectNone(),
    );
  });

  test("received chat messages are timestamped and appended", () => {
    Story.story(
      Chat.update,
      Story.with(connectedChat),
      Story.message(Chat.ReceivedMessage({ text: "[abc] hello" })),
      Story.Command.expectExact(Chat.TimestampMessage({ text: "[abc] hello" })),
      Story.Command.resolve(
        Chat.TimestampMessage,
        Chat.TimestampedMessage({ text: "[abc] hello", zoned: zonedNow }),
      ),
      Story.model((model) => {
        expect(model.messages).toEqual([
          { text: "[abc] hello", zoned: zonedNow },
        ]);
      }),
    );
  });
});
