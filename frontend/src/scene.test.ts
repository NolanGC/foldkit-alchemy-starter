import { DateTime } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { Option } from "effect";

import { RoomsLoaded, SignInMode, update, view, type Model } from "./main";
import { Chat } from "./page";
import { ChatRoute, HomeRoute, LoginRoute, NotFoundRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);

const helloMessage = {
  id: "message-1",
  senderId: "ada00000-0000-0000-0000-000000000000",
  senderName: "Ada",
  body: "hello from ada",
  createdAt,
};

const connectedModel: Model = {
  _tag: "LoggedIn",
  route: ChatRoute({ roomId: "general" }),
  session: { userId: "user-ada", email: "ada@example.com", name: "Ada" },
  rooms: RoomsLoaded({ roomIds: ["general", "random", "feature-requests"] }),
  chatPage: {
    ...Chat.init("general"),
    connection: Chat.ConnectionConnected(),
    history: Chat.HistoryLoaded({ messages: [], hasMore: false }),
  },
};

const loggedOutModel: Model = {
  _tag: "LoggedOut",
  route: LoginRoute(),
  mode: SignInMode(),
  name: "",
  email: "",
  password: "",
  pending: false,
  error: Option.none(),
  checkingSession: false,
  chatPage: Chat.init("general"),
};

describe("view", () => {
  test("logged out, the login route renders the sign-in form", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedOutModel),
      Scene.expect(Scene.role("heading", { name: "Sign in" })).toExist(),
      Scene.expect(Scene.label("Email")).toExist(),
      Scene.expect(Scene.label("Password")).toExist(),
      Scene.expect(Scene.role("button", { name: "Sign in" })).toBeEnabled(),
    );
  });

  test("logged out, the landing page links to sign in", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loggedOutModel, route: HomeRoute() }),
      Scene.expect(Scene.role("link", { name: "Sign in to chat →" })).toExist(),
    );
  });

  test("logged in, the nav shows the user and a sign out button", () => {
    Scene.scene(
      { update, view },
      Scene.with(connectedModel),
      Scene.expect(Scene.text("Ada")).toExist(),
      Scene.expect(Scene.role("button", { name: "Sign out" })).toExist(),
    );
  });

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
      Scene.expect(Scene.role("link", { name: "#feature-requests" })).toExist(),
      Scene.expect(Scene.label("Message")).toExist(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
    );
  });

  test("loading history renders no empty state", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          history: Chat.HistoryLoading(),
        },
      }),
      Scene.expect(Scene.text("No messages yet.")).not.toExist(),
    );
  });

  test("messages render with sender label and body", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          history: Chat.HistoryLoaded({
            messages: [helloMessage],
            hasMore: false,
          }),
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
        ...connectedModel,
        route: ChatRoute({ roomId: "random" }),
        chatPage: {
          ...Chat.init("random"),
          connection: Chat.ConnectionConnected(),
        },
      }),
      Scene.expect(Scene.role("heading", { name: "Room: random" })).toExist(),
    );
  });

  test("an unknown room renders the room not found page", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        route: ChatRoute({ roomId: "secret-lair" }),
        chatPage: Chat.init("secret-lair"),
      }),
      Scene.expect(Scene.role("heading", { name: "Room not found" })).toExist(),
      Scene.expect(Scene.text("There is no #secret-lair room.")).toExist(),
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
      Scene.expect(Scene.role("link", { name: "Back home" })).toExist(),
    );
  });
});
