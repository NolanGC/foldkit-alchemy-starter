import { DateTime, Option } from "effect";
import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import { GotChatMessage, init, update } from "./main";
import { Chat } from "./page";
import { ChatRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);
const localZone = DateTime.zoneMakeLocal();

const helloMessage = {
  id: "message-1",
  senderId: "sender-1",
  body: "hello",
  createdAt,
};

const followUpMessage = {
  id: "message-2",
  senderId: "sender-2",
  body: "hi back",
  createdAt,
};

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

describe("update", () => {
  test("init on the home route joins the general room", () => {
    const [model, commands] = init(url("/"));

    expect(model.route._tag).toBe("Home");
    expect(model.chatPage.roomId).toBe("general");
    expect(model.chatPage.connection._tag).toBe("ConnectionConnecting");
    expect(commands).toHaveLength(0);
  });

  test("init from a chat route captures the room id", () => {
    const [model, commands] = init(url("/chat/random"));

    expect(model.route).toEqual(ChatRoute({ roomId: "random" }));
    expect(model.chatPage.roomId).toBe("random");
    expect(commands).toHaveLength(0);
  });

  test("chat messages are delegated into the chat page", () => {
    const [model] = init(url("/"));

    Story.story(
      update,
      Story.with(model),
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
        expect(model.chatPage.messages).toEqual([helloMessage]);
      }),
    );
  });
});

describe("chat update", () => {
  const connectedChat: Chat.Model = {
    ...Chat.init("general"),
    connection: Chat.ConnectionConnected(),
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

  test("history replaces the message list", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, messages: [helloMessage] }),
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
        expect(model.messages).toEqual([helloMessage, followUpMessage]);
        expect(model.hasMoreHistory).toBe(false);
      }),
    );
  });

  test("older history is prepended", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, messages: [followUpMessage] }),
      Story.message(
        Chat.ReceivedOlderHistory({
          roomId: "general",
          messages: [helloMessage],
          hasMore: false,
        }),
      ),
      Story.model((model) => {
        expect(model.messages).toEqual([helloMessage, followUpMessage]);
      }),
    );
  });

  test("posted messages are appended", () => {
    Story.story(
      Chat.update,
      Story.with({ ...connectedChat, messages: [helloMessage] }),
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
        expect(model.messages).toEqual([helloMessage, followUpMessage]);
      }),
    );
  });

  test("switching rooms clears messages and reconnects", () => {
    const nextModel = Chat.connect(
      { ...connectedChat, messages: [helloMessage] },
      "random",
    );

    expect(nextModel.roomId).toBe("random");
    expect(nextModel.connection._tag).toBe("ConnectionConnecting");
    expect(nextModel.messages).toEqual([]);
    expect(Option.isSome(nextModel.maybeZone)).toBe(true);
  });

  test("stale socket events from the previous room are ignored", () => {
    Story.story(
      Chat.update,
      Story.with({
        ...connectedChat,
        roomId: "random",
        connection: Chat.ConnectionConnecting(),
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
        expect(model.messages).toEqual([]);
      }),
    );
  });
});
