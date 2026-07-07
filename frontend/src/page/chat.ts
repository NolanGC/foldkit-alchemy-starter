import {
  ChatHistoryCursor,
  ChatMessage,
  ClientFrame,
  MAX_CHAT_MESSAGE_BODY_LENGTH,
  ServerFrame,
} from "@foldkit/backend";
import { Button, Input } from "@foldkit/ui";
import {
  Array,
  Data,
  DateTime,
  Duration,
  Effect,
  Match as M,
  Option,
  Queue,
  Schema as S,
  Stream,
  String as String_,
} from "effect";
import {
  Command,
  ManagedResource,
  Render,
  Submodel,
  Subscription,
} from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import { CHAT_SERVICE_URL } from "../config";

const CONNECTION_TIMEOUT_MS = 5000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;

const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);

const CHAT_MESSAGES_SCROLL_ID = "chat-messages-scroll";

class ChatSocketAcquireError extends Data.TaggedError(
  "ChatSocketAcquireError",
)<{
  roomId: string;
  message: string;
}> {}

const decodeServerFrame = S.decodeUnknownOption(S.fromJsonString(ServerFrame));
const encodeClientFrame = S.encodeSync(S.fromJsonString(ClientFrame));

// MODEL

export const ConnectionDisconnected = ts("ConnectionDisconnected");
export const ConnectionConnecting = ts("ConnectionConnecting");
export const ConnectionConnected = ts("ConnectionConnected");
export const ConnectionError = ts("ConnectionError", { error: S.String });

const ConnectionState = S.Union([
  ConnectionDisconnected,
  ConnectionConnecting,
  ConnectionConnected,
  ConnectionError,
]);
type ConnectionState = typeof ConnectionState.Type;

// "History not loaded yet" and "loaded, zero messages" are distinct states:
// conflating them made the empty state flash while switching rooms.
export const HistoryLoading = ts("HistoryLoading");
export const HistoryLoaded = ts("HistoryLoaded", {
  messages: S.Array(ChatMessage),
  hasMore: S.Boolean,
});

const HistoryState = S.Union([HistoryLoading, HistoryLoaded]);
type HistoryState = typeof HistoryState.Type;

export const Model = S.Struct({
  roomId: S.NonEmptyString,
  connection: ConnectionState,
  history: HistoryState,
  messageInput: S.String,
  sendError: S.Option(S.String),
  maybeZone: S.Option(S.TimeZone),
  // Bumped on each reconnect attempt. Included in the chat socket's
  // requirements so bumping it forces `ManagedResource` to re-acquire even
  // though `roomId` hasn't changed — see the `ScheduledReconnect` handler.
  reconnectAttempt: S.Int,
});
export type Model = typeof Model.Type;

type ChatSocketValue = Readonly<{
  roomId: string;
  socket: WebSocket;
}>;

const ChatSocket = ManagedResource.tag<ChatSocketValue>()("ChatSocket");
export type ChatSocketService = ManagedResource.ServiceOf<typeof ChatSocket>;

// MESSAGE

export const Connected = m("Connected", { roomId: S.NonEmptyString });
export const CompletedRequestHistory = m("CompletedRequestHistory");
export const CompletedReleaseChatSocket = m("CompletedReleaseChatSocket");
export const CompletedScrollChatToBottom = m("CompletedScrollChatToBottom");
export const Disconnected = m("Disconnected", { roomId: S.NonEmptyString });
export const FailedConnect = m("FailedConnect", {
  roomId: S.NonEmptyString,
  error: S.String,
});
export const GotLocalZone = m("GotLocalZone", { zone: S.TimeZone });
export const UpdatedMessageInput = m("UpdatedMessageInput", {
  value: S.String,
});
export const SubmittedMessage = m("SubmittedMessage");
export const RequestedOlderHistory = m("RequestedOlderHistory");
export const SucceededSendMessage = m("SucceededSendMessage", {
  text: S.String,
});
export const ReceivedHistory = m("ReceivedHistory", {
  roomId: S.NonEmptyString,
  messages: S.Array(ChatMessage),
  hasMore: S.Boolean,
});
export const ReceivedOlderHistory = m("ReceivedOlderHistory", {
  roomId: S.NonEmptyString,
  messages: S.Array(ChatMessage),
  hasMore: S.Boolean,
});
export const ReceivedMessage = m("ReceivedMessage", {
  roomId: S.NonEmptyString,
  message: ChatMessage,
});
export const ReceivedRejected = m("ReceivedRejected", {
  roomId: S.NonEmptyString,
  reason: S.String,
});
export const ScheduledReconnect = m("ScheduledReconnect", {
  roomId: S.NonEmptyString,
});

export const Message = S.Union([
  Connected,
  CompletedRequestHistory,
  CompletedReleaseChatSocket,
  CompletedScrollChatToBottom,
  Disconnected,
  FailedConnect,
  GotLocalZone,
  UpdatedMessageInput,
  SubmittedMessage,
  RequestedOlderHistory,
  SucceededSendMessage,
  ReceivedHistory,
  ReceivedOlderHistory,
  ReceivedMessage,
  ReceivedRejected,
  ScheduledReconnect,
]);
export type Message = typeof Message.Type;

// INIT

export const init = (roomId: string): Model => ({
  roomId,
  connection: ConnectionConnecting(),
  history: HistoryLoading(),
  messageInput: "",
  sendError: Option.none(),
  maybeZone: Option.none(),
  reconnectAttempt: 0,
});

export const connect = (model: Model, roomId: string): Model =>
  model.roomId === roomId && model.connection._tag === "ConnectionConnected"
    ? model
    : evo(model, {
        roomId: () => roomId,
        connection: () => ConnectionConnecting(),
        history: (history) =>
          model.roomId === roomId ? history : HistoryLoading(),
        messageInput: () => "",
        sendError: () => Option.none(),
        reconnectAttempt: () => 0,
      });

// COMMAND

const sendClientFrame = <A extends Message>(
  roomId: string,
  frame: ClientFrame,
  onSent: () => A,
) =>
  ChatSocket.get.pipe(
    Effect.flatMap((chatSocket) =>
      Effect.sync(() => {
        if (chatSocket.roomId !== roomId) {
          return FailedConnect({ roomId, error: "Socket unavailable" });
        }

        chatSocket.socket.send(encodeClientFrame(frame));
        return onSent();
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () =>
      Effect.succeed(FailedConnect({ roomId, error: "Socket unavailable" })),
    ),
  );

export const SendMessage = Command.define(
  "SendMessage",
  { roomId: S.NonEmptyString, text: S.String },
  SucceededSendMessage,
  FailedConnect,
)(({ roomId, text }) =>
  sendClientFrame(roomId, { _tag: "Post", body: text }, () =>
    SucceededSendMessage({ text }),
  ),
);

export const RequestHistory = Command.define(
  "RequestHistory",
  { roomId: S.NonEmptyString },
  CompletedRequestHistory,
  FailedConnect,
)(({ roomId }) =>
  sendClientFrame(roomId, { _tag: "GetHistory" }, CompletedRequestHistory),
);

export const RequestOlderHistory = Command.define(
  "RequestOlderHistory",
  { roomId: S.NonEmptyString, cursor: ChatHistoryCursor },
  CompletedRequestHistory,
  FailedConnect,
)(({ roomId, cursor }) =>
  sendClientFrame(
    roomId,
    { _tag: "GetOlderHistory", cursor },
    CompletedRequestHistory,
  ),
);

export const ScheduleReconnect = Command.define(
  "ScheduleReconnect",
  { roomId: S.NonEmptyString, delayMs: S.Number },
  ScheduledReconnect,
)(({ roomId, delayMs }) =>
  Effect.sleep(Duration.millis(delayMs)).pipe(
    Effect.as(ScheduledReconnect({ roomId })),
  ),
);

export const GetLocalZone = Command.define(
  "GetLocalZone",
  GotLocalZone,
)(Effect.sync(() => GotLocalZone({ zone: DateTime.zoneMakeLocal() })));

export const ScrollChatToBottom = Command.define(
  "ScrollChatToBottom",
  CompletedScrollChatToBottom,
)(
  Effect.gen(function* () {
    yield* Render.afterPaint;
    yield* Effect.sync(() => {
      const element = document.getElementById(CHAT_MESSAGES_SCROLL_ID);
      if (element === null) {
        return;
      }
      element.scrollTop = element.scrollHeight;
    });
    return CompletedScrollChatToBottom();
  }),
);

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, ChatSocketService>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

// there exists a window between old room socket teardown, could still be getting frames
// and new room switch, so we ignore messages from the wrong room
const whenCurrentRoom =
  (model: Model) =>
  (roomId: string, run: () => UpdateReturn): UpdateReturn =>
    roomId === model.roomId ? run() : [model, []];

export const update = (model: Model, message: Message): UpdateReturn => {
  const inCurrentRoom = whenCurrentRoom(model);

  return M.value(message).pipe(
    withUpdateReturn,
    M.tags({
      Connected: ({ roomId }) =>
        inCurrentRoom(roomId, () => [
          evo(model, {
            connection: () => ConnectionConnected(),
            reconnectAttempt: () => 0,
          }),
          Option.match(model.maybeZone, {
            onNone: () => [RequestHistory({ roomId }), GetLocalZone()],
            onSome: () => [RequestHistory({ roomId })],
          }),
        ]),

      Disconnected: ({ roomId }) =>
        inCurrentRoom(roomId, () => [
          evo(model, { connection: () => ConnectionDisconnected() }),
          [
            ScheduleReconnect({
              roomId,
              delayMs: reconnectDelayMs(model.reconnectAttempt),
            }),
          ],
        ]),

      FailedConnect: ({ roomId, error }) =>
        inCurrentRoom(roomId, () => [
          evo(model, { connection: () => ConnectionError({ error }) }),
          [
            ScheduleReconnect({
              roomId,
              delayMs: reconnectDelayMs(model.reconnectAttempt),
            }),
          ],
        ]),

      GotLocalZone: ({ zone }) => [
        evo(model, { maybeZone: () => Option.some(zone) }),
        [],
      ],

      UpdatedMessageInput: ({ value }) => [
        evo(model, {
          messageInput: () => value,
          sendError: () => Option.none(),
        }),
        [],
      ],

      SubmittedMessage: () => {
        const text = model.messageInput.trim();

        if (
          String_.isEmpty(text) ||
          model.connection._tag !== "ConnectionConnected"
        ) {
          return [model, []];
        }

        return [
          evo(model, { messageInput: () => "" }),
          [SendMessage({ roomId: model.roomId, text })],
        ];
      },

      RequestedOlderHistory: () => {
        if (model.history._tag !== "HistoryLoaded" || !model.history.hasMore) {
          return [model, []];
        }

        return Option.match(Array.head(model.history.messages), {
          onNone: (): UpdateReturn => [model, []],
          onSome: (oldestMessage): UpdateReturn => [
            model,
            [
              RequestOlderHistory({
                roomId: model.roomId,
                cursor: {
                  beforeCreatedAtEpochMillis: DateTime.toEpochMillis(
                    oldestMessage.createdAt,
                  ),
                  beforeId: oldestMessage.id,
                },
              }),
            ],
          ],
        });
      },

      ReceivedHistory: ({ roomId, messages, hasMore }) =>
        inCurrentRoom(roomId, () => [
          evo(model, { history: () => HistoryLoaded({ messages, hasMore }) }),
          [ScrollChatToBottom()],
        ]),

      ReceivedOlderHistory: ({ roomId, messages, hasMore }) =>
        inCurrentRoom(roomId, () => [
          evo(model, {
            history: (history) =>
              history._tag === "HistoryLoaded"
                ? HistoryLoaded({
                    messages: [...messages, ...history.messages],
                    hasMore,
                  })
                : history,
          }),
          [],
        ]),

      ReceivedMessage: ({ roomId, message }) =>
        inCurrentRoom(roomId, () => [
          evo(model, {
            history: (history) =>
              history._tag === "HistoryLoaded"
                ? HistoryLoaded({
                    messages: [...history.messages, message],
                    hasMore: history.hasMore,
                  })
                : history,
          }),
          [ScrollChatToBottom()],
        ]),

      ReceivedRejected: ({ roomId, reason }) =>
        inCurrentRoom(roomId, () => [
          evo(model, { sendError: () => Option.some(reason) }),
          [],
        ]),

      // Bumping `reconnectAttempt` changes the chat socket's requirements
      // value even though `roomId` is unchanged, which is what makes
      // `ManagedResource` release the dead socket and acquire a new one.
      ScheduledReconnect: ({ roomId }) =>
        inCurrentRoom(roomId, () => [
          evo(model, {
            connection: () => ConnectionConnecting(),
            reconnectAttempt: (attempt) => attempt + 1,
          }),
          [],
        ]),
    }),
    M.tag(
      "CompletedRequestHistory",
      "CompletedReleaseChatSocket",
      "CompletedScrollChatToBottom",
      "SucceededSendMessage",
      (): UpdateReturn => [model, []],
    ),
    M.exhaustive,
  );
};

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()(
  (entry) => ({
    chatSocket: entry(
      S.Option(S.Struct({ roomId: S.NonEmptyString, attempt: S.Int })),
      {
        resource: ChatSocket,
        modelToMaybeRequirements: (model) =>
          Option.some({
            roomId: model.roomId,
            attempt: model.reconnectAttempt,
          }),
        acquire: ({ roomId }) =>
          Effect.callback<ChatSocketValue, ChatSocketAcquireError>((resume) => {
            const url = new URL(CHAT_SERVICE_URL);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            url.pathname = `/api/chat/${encodeURIComponent(roomId)}`;
            const socket = new WebSocket(url);

            const handleOpen = () => {
              socket.removeEventListener("error", handleError);
              resume(Effect.succeed({ roomId, socket }));
            };

            const handleError = () => {
              socket.removeEventListener("open", handleOpen);
              resume(
                Effect.fail(
                  new ChatSocketAcquireError({
                    roomId,
                    message: "Failed to connect to chat",
                  }),
                ),
              );
            };

            socket.addEventListener("open", handleOpen);
            socket.addEventListener("error", handleError);

            return Effect.sync(() => {
              socket.removeEventListener("open", handleOpen);
              socket.removeEventListener("error", handleError);
              socket.close();
            });
          }).pipe(
            Effect.timeout(Duration.millis(CONNECTION_TIMEOUT_MS)),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new ChatSocketAcquireError({
                  roomId,
                  message: "Connection timeout",
                }),
              ),
            ),
          ),
        release: ({ socket }) =>
          Effect.sync(() => {
            socket.close();
          }),
        onAcquired: ({ roomId }) => Connected({ roomId }),
        onReleased: () => CompletedReleaseChatSocket(),
        // The framework erases the acquire error type at this boundary, so a
        // guard is needed even though acquire only fails with this error.
        onAcquireError: (error) =>
          error instanceof ChatSocketAcquireError
            ? FailedConnect({ roomId: error.roomId, error: error.message })
            : FailedConnect({ roomId: "unknown", error: String(error) }),
      },
    ),
  }),
);

// SUBSCRIPTION

const ChatSocketStreamMessage = S.Union([
  ReceivedHistory,
  ReceivedOlderHistory,
  ReceivedMessage,
  ReceivedRejected,
  Disconnected,
  FailedConnect,
]);
type ChatSocketStreamMessage = typeof ChatSocketStreamMessage.Type;

const streamChatSocketMessages = ({ roomId, socket }: ChatSocketValue) =>
  Stream.callback<ChatSocketStreamMessage>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            return;
          }
          Option.match(decodeServerFrame(event.data), {
            onNone: () => {},
            onSome: (frame) =>
              M.value(frame).pipe(
                M.tagsExhaustive({
                  History: ({ messages, hasMore }) => {
                    Queue.offerUnsafe(
                      queue,
                      ReceivedHistory({
                        roomId,
                        messages,
                        hasMore,
                      }),
                    );
                  },
                  OlderHistory: ({ messages, hasMore }) => {
                    Queue.offerUnsafe(
                      queue,
                      ReceivedOlderHistory({
                        roomId,
                        messages,
                        hasMore,
                      }),
                    );
                  },
                  Posted: ({ message }) => {
                    Queue.offerUnsafe(
                      queue,
                      ReceivedMessage({ roomId, message }),
                    );
                  },
                  Rejected: ({ reason }) => {
                    Queue.offerUnsafe(
                      queue,
                      ReceivedRejected({ roomId, reason }),
                    );
                  },
                }),
              ),
          });
        };
        const handleClose = () => {
          Queue.offerUnsafe(queue, Disconnected({ roomId }));
          Queue.endUnsafe(queue);
        };
        const handleError = () => {
          Queue.offerUnsafe(
            queue,
            FailedConnect({ roomId, error: "Connection error" }),
          );
          Queue.endUnsafe(queue);
        };

        socket.addEventListener("message", handleMessage);
        socket.addEventListener("close", handleClose);
        socket.addEventListener("error", handleError);

        return { handleMessage, handleClose, handleError };
      }),
      ({ handleMessage, handleClose, handleError }) =>
        Effect.sync(() => {
          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("close", handleClose);
          socket.removeEventListener("error", handleError);
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  );

export const subscriptions = Subscription.make<
  Model,
  Message,
  ChatSocketService
>()((entry) => ({
  chatSocketMessages: entry(
    { isConnected: S.Boolean },
    {
      modelToDependencies: (model) => ({
        isConnected: model.connection._tag === "ConnectionConnected",
      }),
      dependenciesToStream: ({ isConnected }) =>
        isConnected
          ? Stream.unwrap(
              ChatSocket.get.pipe(
                Effect.map(streamChatSocketMessages),
                Effect.catchTag("ResourceNotAvailable", () =>
                  Effect.succeed(Stream.empty),
                ),
              ),
            )
          : Stream.empty,
    },
  ),
}));

// VIEW

export const view = Submodel.defineView<Model, Message>((model): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto flex h-full max-w-5xl px-4 py-8")],
    [
      h.div(
        [h.Class("flex min-h-0 w-full flex-col gap-4")],
        [
          h.header(
            [h.Class("flex items-center justify-between gap-4")],
            [
              h.div(
                [],
                [
                  h.h1(
                    [h.Class("text-2xl font-bold")],
                    [`Room: ${model.roomId}`],
                  ),
                  connectionStatusView(model.connection),
                ],
              ),
            ],
          ),
          historyView(model.history, model.maybeZone),
          messageInputView(model),
        ],
      ),
    ],
  );
});

const connectionStatusView = (connection: ConnectionState): Html => {
  const h = html<Message>();

  return M.value(connection).pipe(
    M.tagsExhaustive({
      ConnectionDisconnected: () =>
        h.p([h.Class("mt-1 text-sm text-neutral-500")], ["Disconnected"]),
      ConnectionConnecting: () =>
        h.p([h.Class("mt-1 text-sm text-neutral-400")], ["Connecting..."]),
      ConnectionConnected: () =>
        h.p([h.Class("mt-1 text-sm text-neutral-400")], ["Connected"]),
      ConnectionError: ({ error }) =>
        h.p(
          [h.Class("mt-1 text-sm text-neutral-400"), h.Role("alert")],
          [error],
        ),
    }),
  );
};

const messageTime = (
  createdAt: DateTime.Utc,
  maybeZone: Option.Option<DateTime.TimeZone>,
): string =>
  DateTime.format(
    Option.match(maybeZone, {
      onNone: () => createdAt,
      onSome: (zone) => DateTime.setZone(createdAt, zone),
    }),
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );

const historyView = (
  history: HistoryState,
  maybeZone: Option.Option<DateTime.TimeZone>,
): Html => {
  const h = html<Message>();

  return h.div(
    [
      h.Id(CHAT_MESSAGES_SCROLL_ID),
      h.Class(
        "min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end",
          ),
        ],
        [
          M.value(history).pipe(
            M.tagsExhaustive({
              HistoryLoading: () => historySkeletonView(),
              HistoryLoaded: ({ messages, hasMore }) =>
                messagesView(messages, hasMore, maybeZone),
            }),
          ),
        ],
      ),
    ],
  );
};

const SKELETON_ROWS: ReadonlyArray<string> = [
  "w-40",
  "w-28",
  "w-52",
  "w-32",
  "w-36",
  "w-44",
  "w-24",
  "w-56",
  "w-32",
  "w-40",
  "w-28",
  "w-48",
  "w-36",
  "w-44",
  "w-32",
];

const historySkeletonView = (): Html => {
  const h = html<Message>();

  return h.ul(
    [h.Class("flex animate-pulse flex-col gap-3")],
    SKELETON_ROWS.map((width, index) =>
      h.keyed("li")(
        `skeleton-${index}`,
        [
          h.Class(
            "inline-flex w-fit max-w-2/3 flex-col gap-2 self-start border border-neutral-800/30 bg-neutral-900/30 px-4 py-3",
          ),
        ],
        [
          h.div([h.Class("h-2.5 w-16 rounded bg-neutral-800/40")], []),
          h.div([h.Class(`h-3 ${width} rounded bg-neutral-800/40`)], []),
        ],
      ),
    ),
  );
};

const messagesView = (
  messages: ReadonlyArray<ChatMessage>,
  hasMore: boolean,
  maybeZone: Option.Option<DateTime.TimeZone>,
): Html => {
  const h = html<Message>();

  return Array.match(messages, {
    onEmpty: () =>
      h.div(
        [
          h.Class(
            "border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-400",
          ),
        ],
        ["No messages yet."],
      ),
    onNonEmpty: (messages) =>
      h.div(
        [],
        [
          hasMore ? loadMoreView() : h.empty,
          h.ul(
            [h.Class("flex flex-col gap-3")],
            Array.map(messages, (message) =>
              h.keyed("li")(
                message.id,
                [
                  h.Class(
                    "self-start border border-neutral-800 bg-neutral-900 px-4 py-3",
                  ),
                ],
                [
                  h.p(
                    [h.Class("text-xs text-neutral-500")],
                    [
                      `${message.senderName} · ${messageTime(message.createdAt, maybeZone)}`,
                    ],
                  ),
                  h.p(
                    [h.Class("mt-1 break-words text-neutral-300")],
                    [message.body],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  });
};

const loadMoreView = (): Html => {
  const h = html<Message>();

  return h.div(
    [h.Class("mb-3 flex justify-center")],
    [
      h.button(
        [
          h.Type("button"),
          h.OnClick(RequestedOlderHistory()),
          h.Class(
            "border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800",
          ),
        ],
        ["Load more"],
      ),
    ],
  );
};

const messageInputView = (model: Model): Html => {
  const h = html<Message>();
  const isConnected = model.connection._tag === "ConnectionConnected";
  const canSend = isConnected && !String_.isEmpty(model.messageInput.trim());

  return h.form(
    [
      h.Class("mx-auto flex w-full max-w-3xl flex-col gap-2"),
      h.OnSubmit(SubmittedMessage()),
    ],
    [
      Option.match(model.sendError, {
        onNone: () => h.empty,
        onSome: (reason) =>
          h.p([h.Class("text-sm text-red-400"), h.Role("alert")], [reason]),
      }),
      h.div(
        [h.Class("flex w-full gap-2")],
        [
          Input.view<Message>({
            id: "chat-message",
            value: model.messageInput,
            placeholder: `Message ${model.roomId}`,
            isDisabled: !isConnected,
            onInput: (value) => UpdatedMessageInput({ value }),
            toView: (attributes) =>
              h.div(
                [h.Class("min-w-0 flex-1")],
                [
                  h.label(
                    [...attributes.label, h.Class("sr-only")],
                    ["Message"],
                  ),
                  h.input([
                    ...attributes.input,
                    h.Autocomplete("off"),
                    h.Spellcheck(false),
                    h.Autocorrect("off"),
                    h.Autocapitalize("off"),
                    h.Attribute(
                      "maxlength",
                      String(MAX_CHAT_MESSAGE_BODY_LENGTH),
                    ),
                    h.Class(
                      "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:border-neutral-400 focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50",
                    ),
                  ]),
                ],
              ),
          }),
          Button.view<Message>({
            type: "submit",
            isDisabled: !canSend,
            toView: (attributes) =>
              h.button(
                [
                  ...attributes.button,
                  h.Class(
                    "border border-neutral-700 bg-neutral-800 px-4 py-3 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
                  ),
                ],
                ["Send"],
              ),
          }),
        ],
      ),
    ],
  );
};
