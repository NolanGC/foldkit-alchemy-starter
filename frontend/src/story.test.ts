// Pure update-logic tests (Foldkit Story): messages in, model + commands
// out. No DOM, no network — commands are asserted and resolved by hand, so
// nothing here proves a websocket or fetch actually behaves as modeled.
//
// Covers:
// - init: cached session lands LoggedIn + fetches rooms; chat routes capture
//   the room id; no session redirects chat routes to login.
// - Room list storage after GotRooms.
// - Top-level delegation of chat messages into the chat page model.
// - Chat connect: requests history, fetches the local zone exactly once
//   (skipped on reconnect when already known).
// - Sending: trims input, clears it on success, ignores empty submissions.
// - History: load replaces loading state, older pages prepend, live posts
//   append; rejected sends surface an error that clears on the next edit.
// - Room switching resets history/connection; stale socket events from the
//   previous room are ignored.
// - Disconnect schedules a reconnect and bumps the attempt counter; a
//   successful reconnect resets it.
//
// Does NOT cover:
// - Rendering (see scene.test.ts) or real command effects (sockets, HTTP).
// - The logged-out form flows: sign-in/sign-up input, pending, auth errors,
//   sign-out.
// - Navigation/URL-change messages after init.
// - Reconnect backoff growth beyond the first retry (only delayMs 500 and
//   attempt 0→1 are asserted).
// - Requesting older history (only the handling of its result frame).
import { MessageId, UserId } from "@foldkit/backend";
import { DateTime, Option } from "effect";
import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import { GotChatMessage, GotRooms, init, update, type Model } from "./main";
import { Chat } from "./page";
import { ChatRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);
const localZone = DateTime.zoneMakeLocal();

const session = {
  userId: UserId.make("user-1"),
  email: "ada@example.com",
  name: "Ada",
};
const loggedInFlags = { maybeSession: Option.some(session) };
const loggedOutFlags = { maybeSession: Option.none<typeof session>() };

const asLoggedIn = (model: Model): Extract<Model, { _tag: "LoggedIn" }> => {
  if (model._tag !== "LoggedIn") {
    throw new Error(`Expected LoggedIn model, got ${model._tag}`);
  }
  return model;
};

const helloMessage = {
  id: MessageId.make("00000000-0000-4000-8000-000000000001"),
  senderId: UserId.make("sender-1"),
  senderName: "Sender One",
  body: "hello",
  createdAt,
};

const followUpMessage = {
  id: MessageId.make("00000000-0000-4000-8000-000000000002"),
  senderId: UserId.make("sender-2"),
  senderName: "Sender Two",
  body: "hi back",
  createdAt,
};

const loadedHistory = (
  messages: ReadonlyArray<typeof helloMessage>,
): ReturnType<typeof Chat.HistoryLoaded> =>
  Chat.HistoryLoaded({ messages, hasMore: false });

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

describe("update", () => {
  test("init with a cached session lands logged in and fetches rooms", () => {
    const [model, commands] = init(loggedInFlags, url("/"));
    const loggedIn = asLoggedIn(model);

    expect(loggedIn.route._tag).toBe("Home");
    expect(loggedIn.rooms._tag).toBe("RoomsLoading");
    expect(loggedIn.chatPage.roomId).toBe("general");
    // FetchRooms + the boot-time CheckSession revalidation.
    expect(commands).toHaveLength(2);
  });

  test("init from a chat route captures the room id", () => {
    const [model] = init(loggedInFlags, url("/chat/random"));
    const loggedIn = asLoggedIn(model);

    expect(loggedIn.route).toEqual(ChatRoute({ roomId: "random" }));
    expect(loggedIn.chatPage.roomId).toBe("random");
  });

  test("init without a session redirects chat routes to login", () => {
    const [model, commands] = init(loggedOutFlags, url("/chat/general"));

    expect(model._tag).toBe("LoggedOut");
    expect(model.route._tag).toBe("Login");
    // RedirectToLogin + CheckSession.
    expect(commands).toHaveLength(2);
  });

  test("the fetched room list is stored", () => {
    const [model] = init(loggedInFlags, url("/"));
    const [next] = update(
      model,
      GotRooms({ roomIds: ["general", "random", "feature-requests"] }),
    );
    const loggedIn = asLoggedIn(next);

    expect(loggedIn.rooms._tag).toBe("RoomsLoaded");
    expect(loggedIn.rooms).toMatchObject({
      roomIds: ["general", "random", "feature-requests"],
    });
  });

  test("chat messages are delegated into the chat page", () => {
    const [model] = init(loggedInFlags, url("/"));
    const loggedIn = asLoggedIn(model);
    const loadedModel = {
      ...loggedIn,
      chatPage: { ...loggedIn.chatPage, history: loadedHistory([]) },
    };

    Story.story(
      update,
      Story.with(loadedModel),
      Story.message(
        GotChatMessage({
          message: Chat.ReceivedMessage({
            roomId: "general",
            message: helloMessage,
          }),
        }),
      ),
      Story.Command.resolve(
        Chat.ScrollChatToBottom,
        Chat.CompletedScrollChatToBottom(),
        (message) => GotChatMessage({ message }),
      ),
      Story.model((model) => {
        expect(model.chatPage.history).toEqual(loadedHistory([helloMessage]));
      }),
    );
  });
});

describe("chat update", () => {
  const connectedChat: Chat.Model = {
    ...Chat.init("general"),
    connection: Chat.ConnectionConnected(),
    history: loadedHistory([]),
    maybeZone: Option.some(localZone),
  };

  test("connecting requests history and fetches the local time zone once", () => {
    Story.story(
      Chat.update,
      Story.with(Chat.init("general")),
      Story.message(Chat.Connected({ roomId: "general" })),
      Story.Command.expectHas(Chat.RequestHistory({ roomId: "general" })),
      Story.Command.expectHas(Chat.GetLocalZone()),
      Story.Command.resolve(
        Chat.RequestHistory,
        Chat.CompletedRequestHistory(),
      ),
      Story.Command.resolve(
        Chat.GetLocalZone,
        Chat.GotLocalZone({ zone: localZone }),
      ),
      Story.model((model) => {
        expect(model.connection._tag).toBe("ConnectionConnected");
        expect(Option.isSome(model.maybeZone)).toBe(true);
      }),
    );
  });

  test("reconnecting with a known zone skips the zone lookup", () => {
    Story.story(
      Chat.update,
      Story.with({
        ...connectedChat,
        connection: Chat.ConnectionConnecting(),
      }),
      Story.message(Chat.Connected({ roomId: "general" })),
      Story.Command.expectExact(Chat.RequestHistory({ roomId: "general" })),
      Story.Command.resolve(
        Chat.RequestHistory,
        Chat.CompletedRequestHistory(),
      ),
    );
  });

  test("submitting a connected chat message sends and clears the input", () => {
    const sendMessageCommand = Chat.SendMessage({
      roomId: "general",
      text: "hello",
    });

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

  test("history replaces the loading state", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, history: Chat.HistoryLoading() }),
      Story.message(
        Chat.ReceivedHistory({
          roomId: "general",
          messages: [helloMessage, followUpMessage],
          hasMore: false,
        }),
      ),
      Story.Command.expectExact(Chat.ScrollChatToBottom()),
      Story.Command.resolve(
        Chat.ScrollChatToBottom,
        Chat.CompletedScrollChatToBottom(),
      ),
      Story.model((model) => {
        expect(model.history).toEqual(
          loadedHistory([helloMessage, followUpMessage]),
        );
      }),
    );
  });

  test("older history is prepended", () => {
    Story.story(
      Chat.update,
      Story.with({
        ...connectedChat,
        history: loadedHistory([followUpMessage]),
      }),
      Story.message(
        Chat.ReceivedOlderHistory({
          roomId: "general",
          messages: [helloMessage],
          hasMore: false,
        }),
      ),
      Story.model((model) => {
        expect(model.history).toEqual(
          loadedHistory([helloMessage, followUpMessage]),
        );
      }),
    );
  });

  test("a rejected message surfaces an error and clears on the next edit", () => {
    Story.story(
      Chat.update,
      Story.with(connectedChat),
      Story.message(
        Chat.ReceivedRejected({ roomId: "general", reason: "Too long." }),
      ),
      Story.model((model) => {
        expect(model.sendError).toEqual(Option.some("Too long."));
      }),
      Story.message(Chat.UpdatedMessageInput({ value: "hi" })),
      Story.model((model) => {
        expect(model.sendError).toEqual(Option.none());
      }),
    );
  });

  test("posted messages are appended", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, history: loadedHistory([helloMessage]) }),
      Story.message(
        Chat.ReceivedMessage({
          roomId: "general",
          message: followUpMessage,
        }),
      ),
      Story.Command.expectExact(Chat.ScrollChatToBottom()),
      Story.Command.resolve(
        Chat.ScrollChatToBottom,
        Chat.CompletedScrollChatToBottom(),
      ),
      Story.model((model) => {
        expect(model.history).toEqual(
          loadedHistory([helloMessage, followUpMessage]),
        );
      }),
    );
  });

  test("switching rooms resets history to loading and reconnects", () => {
    const nextModel = Chat.connect(
      { ...connectedChat, history: loadedHistory([helloMessage]) },
      "random",
    );

    expect(nextModel.roomId).toBe("random");
    expect(nextModel.connection._tag).toBe("ConnectionConnecting");
    expect(nextModel.history).toEqual(Chat.HistoryLoading());
    expect(Option.isSome(nextModel.maybeZone)).toBe(true);
  });

  test("stale socket events from the previous room are ignored", () => {
    Story.story(
      Chat.update,
      Story.with({
        ...connectedChat,
        roomId: "random",
        connection: Chat.ConnectionConnecting(),
        history: Chat.HistoryLoading(),
      }),
      Story.message(Chat.Disconnected({ roomId: "general" })),
      Story.message(
        Chat.ReceivedHistory({
          roomId: "general",
          messages: [helloMessage],
          hasMore: false,
        }),
      ),
      Story.Command.expectNone(),
      Story.model((model) => {
        expect(model.roomId).toBe("random");
        expect(model.connection._tag).toBe("ConnectionConnecting");
        expect(model.history).toEqual(Chat.HistoryLoading());
      }),
    );
  });

  test("an unexpected disconnect schedules a reconnect and bumps the attempt on retry", () => {
    Story.story(
      Chat.update,
      Story.with(connectedChat),
      Story.message(Chat.Disconnected({ roomId: "general" })),
      Story.Command.expectExact(
        Chat.ScheduleReconnect({ roomId: "general", delayMs: 500 }),
      ),
      Story.model((model) => {
        expect(model.connection._tag).toBe("ConnectionDisconnected");
        expect(model.reconnectAttempt).toBe(0);
      }),
      Story.Command.resolve(
        Chat.ScheduleReconnect,
        Chat.ScheduledReconnect({ roomId: "general" }),
      ),
      Story.model((model) => {
        expect(model.connection._tag).toBe("ConnectionConnecting");
        expect(model.reconnectAttempt).toBe(1);
      }),
    );
  });

  test("a successful reconnect resets the attempt counter", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, reconnectAttempt: 3 }),
      Story.message(Chat.Connected({ roomId: "general" })),
      Story.Command.resolve(
        Chat.RequestHistory,
        Chat.CompletedRequestHistory(),
      ),
      Story.model((model) => {
        expect(model.reconnectAttempt).toBe(0);
      }),
    );
  });
});
