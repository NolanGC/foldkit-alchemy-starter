import { DateTime } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { update, view, type Model } from "./main";
import { Chat } from "./page";
import { ChatRoute, HomeRoute, NotFoundRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);

const helloMessage = {
  id: "message-1",
  senderId: "ada00000-0000-0000-0000-000000000000",
  body: "hello from ada",
  createdAt,
};

const connectedModel: Model = {
  route: ChatRoute({ roomId: "general" }),
  chatPage: {
    ...Chat.init("general"),
    connection: Chat.ConnectionConnected(),
  },
};

describe("view", () => {
  test("the home route renders the landing page", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...connectedModel, route: HomeRoute() }),
      Scene.expect(Scene.role("heading", { name: "FoldkitChat" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Enter chat →" })).toExist(),
    );
  });

  test("an empty connected room renders the composer", () => {
    Scene.scene(
      { update, view },
      Scene.with(connectedModel),
      Scene.expect(Scene.role("heading", { name: "Room: general" })).toExist(),
      Scene.expect(Scene.text("No messages yet.")).toExist(),
      Scene.expect(Scene.text("Connected")).toExist(),
      Scene.expect(Scene.role("link", { name: "#general" })).toExist(),
      Scene.expect(Scene.role("link", { name: "#random" })).toExist(),
      Scene.expect(Scene.label("Message")).toExist(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
    );
  });

  test("messages render with sender label and body", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          messages: [helloMessage],
        },
      }),
      Scene.expect(Scene.text("hello from ada")).toExist(),
    );
  });

  test("typing a message enables the send button", () => {
    Scene.scene(
      { update, view },
      Scene.with(connectedModel),
      Scene.type(Scene.label("Message"), "hello there"),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeEnabled(),
    );
  });

  test("a chat room route renders that room", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        route: ChatRoute({ roomId: "random" }),
        chatPage: {
          ...Chat.init("random"),
          connection: Chat.ConnectionConnected(),
        },
      }),
      Scene.expect(Scene.role("heading", { name: "Room: random" })).toExist(),
    );
  });

  test("chat connection errors are announced", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          connection: Chat.ConnectionError({ error: "Connection timeout" }),
        },
      }),
      Scene.expect(Scene.role("alert")).toExist(),
      Scene.expect(Scene.text("Connection timeout")).toExist(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
    );
  });

  test("unknown routes render the not found page", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        route: NotFoundRoute({ path: "/missing" }),
      }),
      Scene.expect(Scene.role("heading", { name: "Page not found" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Back to chat" })).toExist(),
    );
  });
});
