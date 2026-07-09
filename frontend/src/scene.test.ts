// View-rendering tests (Foldkit Scene): a model in, semantic queries
// (roles/labels/text) against the rendered view out. No real browser and no
// command execution — interactions are limited to what Scene simulates.
//
// Covers:
// - Logged out: the login route renders the sign-in form; the landing page
//   links to sign-in.
// - Logged in: nav shows the user's name and a sign-out button; the home
//   route renders the landing page.
// - Chat room rendering: heading, empty state, connection status, room
//   links, labeled composer with Send disabled when empty and enabled after
//   typing; loading history suppresses the empty state; a loaded message's
//   body renders.
// - Routing views: a /chat/:roomId route renders that room, an unknown room
//   renders "Room not found", unknown paths render "Page not found".
// - A chat connection error renders as role="alert" and disables Send; so
//   does the rejected-send banner, which clears on the next edit.
// - Disconnected state shows its status and disables the composer.
// - A partial history (hasMore) offers the "Load more" button.
//
// Does NOT cover:
// - Click flows: sending a message, signing out, navigating via room links,
//   clicking "Load more" (typing is the only interaction exercised).
// - Message metadata rendering (sender label is asserted only via body text;
//   timestamps/zone formatting untested).
// - The Connecting state's rendering.
// - Anything visual: layout, styling, focus management.
import { MessageId, UserId } from "@foldkit/backend";
import { DateTime } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { Option } from "effect";

import { RoomsLoaded, update, view, type Model } from "./main";
import { Chat, Login } from "./page";
import { ChatRoute, HomeRoute, LoginRoute, NotFoundRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);

const helloMessage = {
  id: MessageId.make("00000000-0000-4000-8000-000000000001"),
  senderId: UserId.make("ada00000-0000-0000-0000-000000000000"),
  senderName: "Ada",
  body: "hello from ada",
  createdAt,
};

const connectedModel: Model = {
  _tag: "LoggedIn",
  route: ChatRoute({ roomId: "general" }),
  session: {
    userId: UserId.make("user-ada"),
    email: "ada@example.com",
    name: "Ada",
  },
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
  loginPage: Login.init(false),
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

  test("a rejected send renders an alert that clears on the next edit", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          sendError: Option.some("Too long."),
        },
      }),
      Scene.expect(Scene.role("alert")).toExist(),
      Scene.expect(Scene.text("Too long.")).toExist(),
      Scene.type(Scene.label("Message"), "shorter"),
      Scene.expect(Scene.role("alert")).not.toExist(),
    );
  });

  test("a disconnected room shows the status and disables the composer", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          connection: Chat.ConnectionDisconnected(),
          messageInput: "drafted while offline",
        },
      }),
      Scene.expect(Scene.text("Disconnected")).toExist(),
      Scene.expect(Scene.label("Message")).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
    );
  });

  test("a partial history offers to load more", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...connectedModel,
        chatPage: {
          ...connectedModel.chatPage,
          history: Chat.HistoryLoaded({
            messages: [helloMessage],
            hasMore: true,
          }),
        },
      }),
      Scene.expect(Scene.role("button", { name: "Load more" })).toExist(),
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
