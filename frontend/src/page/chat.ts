import { Button, Input } from "@foldkit/ui";
import {
  Duration,
  Effect,
  Match as M,
  Option,
  Queue,
  Schema as S,
  Stream,
  String as Str,
} from "effect";
import { Command, ManagedResource, Submodel, Subscription } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

const CONNECTION_TIMEOUT_MS = 5000;

// MODEL

export const ChatMessage = S.Struct({
  text: S.String,
});
export type ChatMessage = typeof ChatMessage.Type;

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
  messageInput: S.String,
});
export type Model = typeof Model.Type;

const ChatSocket = ManagedResource.tag<WebSocket>()("ChatSocket");
export type ChatSocketService = ManagedResource.ServiceOf<typeof ChatSocket>;

// MESSAGE

export const Connected = m("Connected");
export const Disconnected = m("Disconnected");
export const FailedConnect = m("FailedConnect", { error: S.String });
export const UpdatedMessageInput = m("UpdatedMessageInput", {
  value: S.String,
});
export const SubmittedMessage = m("SubmittedMessage");
export const SucceededSendMessage = m("SucceededSendMessage", {
  text: S.String,
});
export const ReceivedMessage = m("ReceivedMessage", { text: S.String });

export const Message = S.Union([
  Connected,
  Disconnected,
  FailedConnect,
  UpdatedMessageInput,
  SubmittedMessage,
  SucceededSendMessage,
  ReceivedMessage,
]);
export type Message = typeof Message.Type;

// INIT

export const init = (roomId: string): Model => ({
  roomId,
  connection: ConnectionConnecting(),
  messages: [],
  messageInput: "",
});

export const connect = (model: Model, roomId: string): Model =>
  model.roomId === roomId && model.connection._tag === "ConnectionConnected"
    ? model
    : {
        roomId,
        connection: ConnectionConnecting(),
        messages: model.roomId === roomId ? model.messages : [],
        messageInput: "",
      };

// COMMAND

export const SendMessage = Command.define(
  "SendMessage",
  { text: S.String },
  SucceededSendMessage,
  FailedConnect,
)(({ text }) =>
  ChatSocket.get.pipe(
    Effect.flatMap((socket) =>
      Effect.sync(() => {
        socket.send(text);
        return SucceededSendMessage({ text });
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () =>
      Effect.succeed(FailedConnect({ error: "Socket unavailable" })),
    ),
  ),
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
      Connected: () => [
        evo(model, { connection: () => ConnectionConnected() }),
        [],
      ],

      Disconnected: () => [
        evo(model, { connection: () => ConnectionDisconnected() }),
        [],
      ],

      FailedConnect: ({ error }) => [
        evo(model, { connection: () => ConnectionError({ error }) }),
        [],
      ],

      UpdatedMessageInput: ({ value }) => [
        evo(model, { messageInput: () => value }),
        [],
      ],

      SubmittedMessage: () => {
        const text = model.messageInput.trim();

        if (
          Str.isEmpty(text) ||
          model.connection._tag !== "ConnectionConnected"
        ) {
          return [model, []];
        }

        return [
          evo(model, { messageInput: () => "" }),
          [SendMessage({ text })],
        ];
      },

      SucceededSendMessage: () => [model, []],

      ReceivedMessage: ({ text }) => [
        evo(model, {
          messages: (messages) => [...messages, ChatMessage.make({ text })],
        }),
        [],
      ],
    }),
  );

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()(
  (entry) => ({
    chatSocket: entry(S.Option(S.Struct({ roomId: S.NonEmptyString })), {
      resource: ChatSocket,
      modelToMaybeRequirements: (model) =>
        model.connection._tag === "ConnectionConnecting" ||
        model.connection._tag === "ConnectionConnected"
          ? Option.some({ roomId: model.roomId })
          : Option.none(),
      acquire: ({ roomId }) =>
        Effect.callback<WebSocket, Error>((resume) => {
          const socket = new WebSocket(chatWebSocketUrl(roomId));

          const handleOpen = () => {
            socket.removeEventListener("error", handleError);
            resume(Effect.succeed(socket));
          };

          const handleError = () => {
            socket.removeEventListener("open", handleOpen);
            resume(Effect.fail(new Error("Failed to connect to chat")));
          };

          socket.addEventListener("open", handleOpen);
          socket.addEventListener("error", handleError);

          return Effect.sync(() => {
            socket.removeEventListener("open", handleOpen);
            socket.removeEventListener("error", handleError);
          });
        }).pipe(
          Effect.timeout(Duration.millis(CONNECTION_TIMEOUT_MS)),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new Error("Connection timeout")),
          ),
        ),
      release: (socket) =>
        Effect.sync(() => {
          socket.close();
        }),
      onAcquired: () => Connected(),
      onReleased: () => Disconnected(),
      onAcquireError: (error) =>
        FailedConnect({
          error: error instanceof Error ? error.message : String(error),
        }),
    }),
  }),
);

// SUBSCRIPTION

const toTextMessage = (data: MessageEvent["data"]): string => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  throw new Error("Unsupported WebSocket message type");
};
const chatWebSocketUrl = (roomId: string): string => {
  const chatUrl = import.meta.env.VITE_CHAT_SERVICE_URL;
  if (chatUrl === undefined) {
    throw new Error("No chat service url found in environment.")
  }
  const url = new URL(chatUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(roomId)}`;
  return url.toString();
};

const streamChatSocketMessages = (socket: WebSocket) =>
  Stream.callback<
    | typeof ReceivedMessage.Type
    | typeof Disconnected.Type
    | typeof FailedConnect.Type
  >((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handleMessage = (event: MessageEvent) => {
          Queue.offerUnsafe(queue, ReceivedMessage({ text: toTextMessage(event.data) }));
        };
        const handleClose = () => {
          Queue.offerUnsafe(queue, Disconnected());
          Queue.endUnsafe(queue);
        };
        const handleError = () => {
          Queue.offerUnsafe(queue, FailedConnect({ error: "Connection error" }));
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
    [h.Class("mx-auto flex min-h-[calc(100vh-120px)] max-w-5xl px-4 py-8")],
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
                  h.h1([h.Class("text-2xl font-bold")], [
                    `Room: ${model.roomId}`,
                  ]),
                  connectionStatusView(model.connection),
                ],
              ),
            ],
          ),
          messagesView(model.messages),
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
        h.p([h.Class("mt-1 text-sm text-neutral-400")], [error]),
    }),
  );
};

const messagesView = (messages: ReadonlyArray<ChatMessage>): Html => {
  const h = html<Message>();

  return h.div(
    [
      h.Class(
        "flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-y-auto",
      ),
    ],
    messages.length === 0
      ? [
          h.div(
            [
              h.Class(
                "self-start border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-400",
              ),
            ],
            ["No messages yet."],
          ),
        ]
      : messages.map((message, index) =>
          h.keyed("div")(
            `${index}:${message.text}`,
            [
              h.Class(
                "self-start border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-300",
              ),
            ],
            [message.text],
          ),
        ),
  );
};

const messageInputView = (model: Model): Html => {
  const h = html<Message>();
  const isConnected = model.connection._tag === "ConnectionConnected";
  const canSend = isConnected && !Str.isEmpty(model.messageInput.trim());

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
                h.Class(
                  "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-500 disabled:opacity-50",
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
