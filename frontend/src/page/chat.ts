import {
  ChatHistoryCursor,
  ChatMessage,
  ClientFrame,
  ServerFrame,
} from "@foldkit/backend";
import { Button, Input } from "@foldkit/ui";
import {
  Array,
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

const CONNECTION_TIMEOUT_MS = 5000;

const CHAT_SERVICE_URL = import.meta.env.VITE_CHAT_SERVICE_URL;
if (CHAT_SERVICE_URL === undefined) {
  throw new Error("VITE_CHAT_SERVICE_URL is not set.");
}

const CHAT_MESSAGES_SCROLL_ID = "chat-messages-scroll";

class ChatSocketAcquireError extends Error {
  constructor(
    readonly roomId: string,
    message: string,
  ) {
    super(message);
  }
}

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

export const Model = S.Struct({
  roomId: S.NonEmptyString,
  connection: ConnectionState,
  messages: S.Array(ChatMessage),
  hasMoreHistory: S.Boolean,
  messageInput: S.String,
  maybeZone: S.Option(S.TimeZone),
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
]);
export type Message = typeof Message.Type;

// INIT

export const init = (roomId: string): Model => ({
  roomId,
  connection: ConnectionConnecting(),
  messages: [],
  hasMoreHistory: false,
  messageInput: "",
  maybeZone: Option.none(),
});

export const connect = (model: Model, roomId: string): Model =>
  model.roomId === roomId && model.connection._tag === "ConnectionConnected"
    ? model
    : evo(model, {
        roomId: () => roomId,
        connection: () => ConnectionConnecting(),
        messages: (messages) => (model.roomId === roomId ? messages : []),
        hasMoreHistory: () => false,
        messageInput: () => "",
      });

// COMMAND

export const SendMessage = Command.define(
  "SendMessage",
  { roomId: S.NonEmptyString, text: S.String },
  SucceededSendMessage,
  FailedConnect,
)(({ roomId, text }) =>
  ChatSocket.get.pipe(
    Effect.flatMap((chatSocket) =>
      Effect.sync(() => {
        if (chatSocket.roomId !== roomId) {
          return FailedConnect({ roomId, error: "Socket unavailable" });
        }

        chatSocket.socket.send(encodeClientFrame({ _tag: "Post", body: text }));
        return SucceededSendMessage({ text });
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () =>
      Effect.succeed(FailedConnect({ roomId, error: "Socket unavailable" })),
    ),
  ),
);

export const RequestHistory = Command.define(
  "RequestHistory",
  { roomId: S.NonEmptyString },
  CompletedRequestHistory,
  FailedConnect,
)(({ roomId }) =>
  ChatSocket.get.pipe(
    Effect.flatMap((chatSocket) =>
      Effect.sync(() => {
        if (chatSocket.roomId !== roomId) {
          return FailedConnect({ roomId, error: "Socket unavailable" });
        }

        chatSocket.socket.send(encodeClientFrame({ _tag: "GetHistory" }));
        return CompletedRequestHistory();
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () =>
      Effect.succeed(FailedConnect({ roomId, error: "Socket unavailable" })),
    ),
  ),
);

export const RequestOlderHistory = Command.define(
  "RequestOlderHistory",
  { roomId: S.NonEmptyString, cursor: ChatHistoryCursor },
  CompletedRequestHistory,
  FailedConnect,
)(({ roomId, cursor }) =>
  ChatSocket.get.pipe(
    Effect.flatMap((chatSocket) =>
      Effect.sync(() => {
        if (chatSocket.roomId !== roomId) {
          return FailedConnect({ roomId, error: "Socket unavailable" });
        }

        chatSocket.socket.send(
          encodeClientFrame({ _tag: "GetOlderHistory", cursor }),
        );
        return CompletedRequestHistory();
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () =>
      Effect.succeed(FailedConnect({ roomId, error: "Socket unavailable" })),
    ),
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

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      Connected: ({ roomId }) =>
        roomId === model.roomId
          ? [
              evo(model, { connection: () => ConnectionConnected() }),
              [
                RequestHistory({ roomId }),
                ...(Option.isNone(model.maybeZone) ? [GetLocalZone()] : []),
              ],
            ]
          : [model, []],

      CompletedRequestHistory: () => [model, []],

      CompletedReleaseChatSocket: () => [model, []],

      CompletedScrollChatToBottom: () => [model, []],

      Disconnected: ({ roomId }) =>
        roomId === model.roomId
          ? [
              evo(model, { connection: () => ConnectionDisconnected() }),
              [],
            ]
          : [model, []],

      FailedConnect: ({ roomId, error }) =>
        roomId === model.roomId
          ? [
              evo(model, { connection: () => ConnectionError({ error }) }),
              [],
            ]
          : [model, []],

      GotLocalZone: ({ zone }) => [
        evo(model, { maybeZone: () => Option.some(zone) }),
        [],
      ],

      UpdatedMessageInput: ({ value }) => [
        evo(model, { messageInput: () => value }),
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
        const oldestMessage = model.messages[0];
        if (!model.hasMoreHistory || !oldestMessage) {
          return [model, []];
        }

        return [
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
        ];
      },

      SucceededSendMessage: () => [model, []],

      ReceivedHistory: ({ roomId, messages, hasMore }) =>
        roomId === model.roomId
          ? [
              evo(model, {
                messages: () => messages,
                hasMoreHistory: () => hasMore,
              }),
              [ScrollChatToBottom()],
            ]
          : [model, []],

      ReceivedOlderHistory: ({ roomId, messages, hasMore }) =>
        roomId === model.roomId
          ? [
              evo(model, {
                messages: (existing) => [...messages, ...existing],
                hasMoreHistory: () => hasMore,
              }),
              [],
            ]
          : [model, []],

      ReceivedMessage: ({ roomId, message }) =>
        roomId === model.roomId
          ? [
              evo(model, { messages: (messages) => [...messages, message] }),
              [ScrollChatToBottom()],
            ]
          : [model, []],
    }),
  );

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()(
  (entry) => ({
    chatSocket: entry(S.Option(S.Struct({ roomId: S.NonEmptyString })), {
      resource: ChatSocket,
      modelToMaybeRequirements: (model) =>
        Option.some({ roomId: model.roomId }),
      acquire: ({ roomId }) =>
        Effect.callback<ChatSocketValue, Error>((resume) => {
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
                new ChatSocketAcquireError(
                  roomId,
                  "Failed to connect to chat",
                ),
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
              new ChatSocketAcquireError(roomId, "Connection timeout"),
            ),
          ),
        ),
      release: ({ socket }) =>
        Effect.sync(() => {
          socket.close();
        }),
      onAcquired: ({ roomId }) => Connected({ roomId }),
      onReleased: () => CompletedReleaseChatSocket(),
      onAcquireError: (error) =>
        FailedConnect({
          roomId:
            error instanceof ChatSocketAcquireError ? error.roomId : "unknown",
          error: error instanceof Error ? error.message : String(error),
        }),
    }),
  }),
);

// SUBSCRIPTION

const streamChatSocketMessages = ({ roomId, socket }: ChatSocketValue) =>
  Stream.callback<
    | typeof ReceivedHistory.Type
    | typeof ReceivedOlderHistory.Type
    | typeof ReceivedMessage.Type
    | typeof Disconnected.Type
    | typeof FailedConnect.Type
  >((queue) =>
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
        Stream.when(
          Stream.unwrap(
            ChatSocket.get.pipe(
              Effect.map(streamChatSocketMessages),
              Effect.catchTag("ResourceNotAvailable", () =>
                Effect.succeed(Stream.empty),
              ),
            ),
          ),
          Effect.sync(() => isConnected),
        ),
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
          messagesView(model.messages, model.hasMoreHistory, model.maybeZone),
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

const senderLabel = (senderId: string): string =>
  `user-${senderId.slice(0, 5)}`;

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

const messagesView = (
  messages: ReadonlyArray<ChatMessage>,
  hasMoreHistory: boolean,
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
        [h.Class("mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end")],
        [
          ...Array.match(messages, {
            onEmpty: () => [
              h.div(
                [
                  h.Class(
                    "border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-400",
                  ),
                ],
                ["No messages yet."],
              ),
            ],
            onNonEmpty: (messages) => [
              ...(hasMoreHistory
                ? [
                    h.div(
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
                    ),
                  ]
                : []),
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
                          `${senderLabel(message.senderId)} · ${messageTime(message.createdAt, maybeZone)}`,
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
          }),
        ],
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
      h.Class("mx-auto flex w-full max-w-3xl gap-2"),
      h.OnSubmit(SubmittedMessage()),
    ],
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
              h.label([...attributes.label, h.Class("sr-only")], ["Message"]),
              h.input([
                ...attributes.input,
                h.Autocomplete("off"),
                h.Spellcheck(false),
                h.Autocorrect("off"),
                h.Autocapitalize("off"),
                h.Class(
                  "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none focus:ring-0 disabled:opacity-50",
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
  );
};
