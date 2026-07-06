import * as Cloudflare from "alchemy/Cloudflare";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import * as String_ from "effect/String";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  ChatMessage,
  type ChatHistoryCursor,
  ClientFrame,
  MAX_CHAT_MESSAGE_BODY_LENGTH,
  ServerFrame,
} from "./ChatProtocol.ts";
import ChatPersistenceService from "./ChatPersistenceService.ts";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

const HISTORY_LIMIT = 50;
const BROADCAST_CONCURRENCY = 32;

const decodeClientFrame = S.decodeUnknownOption(S.fromJsonString(ClientFrame));
const encodeServerFrame = S.encodeSync(S.fromJsonString(ServerFrame));

// The persistence wire format is `ChatMessage`'s encoded form, so the schema
// codec is the whole mapping layer between the socket and the database.
const decodeChatMessage = S.decodeSync(ChatMessage);
const encodeChatMessage = S.encodeSync(ChatMessage);

type Attachment = { id: string; roomId: string };

type HistoryCache = {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly hasMore: boolean;
};

const textFromSocketMessage = (message: string | ArrayBuffer): string =>
  typeof message === "string" ? message : new TextDecoder().decode(message);

// Fails loudly rather than falling back to a default room: silently
// mis-rooming messages on a routing bug would be much worse than a 500.
const roomIdFromRequestUrl = (url: string): string => {
  const segment = new URL(url, "http://chat").pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (segment === undefined) {
    throw new Error(`No room id in request URL: ${url}`);
  }
  return decodeURIComponent(segment);
};

export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const persistence = yield* Cloudflare.Workers.bindWorker(
      ChatPersistenceService,
    );

    return Effect.gen(function* () {
      const sessions = new Map<string, Cloudflare.WebSocket>();
      // Rebuilt from Postgres on the first join after each activation; kept
      // current in memory afterwards so joins don't hit the database.
      const historyCache = yield* Ref.make(Option.none<HistoryCache>());

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<Attachment>();
        if (data) sessions.set(data.id, socket);
      }

      const loadHistory = (roomId: string, cursor?: ChatHistoryCursor) =>
        Effect.gen(function* () {
          const cached = yield* Ref.get(historyCache);
          if (cursor === undefined && Option.isSome(cached)) {
            return cached.value;
          }
          const page = yield* persistence.getRoomHistory(
            roomId,
            HISTORY_LIMIT,
            cursor,
          );
          const messages = Array.map(page.messages, (message) =>
            decodeChatMessage(message),
          );
          yield* Ref.update(historyCache, (current) =>
            cursor === undefined
              ? Option.some({ messages, hasMore: page.hasMore })
              : Option.map(current, (existing) => ({
                  messages: [...messages, ...existing.messages],
                  hasMore: page.hasMore,
                })),
          );
          return { messages, hasMore: page.hasMore };
        });

      const appendToHistory = (message: ChatMessage) =>
        Ref.update(
          historyCache,
          Option.map((cache) => ({
            messages: [...cache.messages, message].slice(-HISTORY_LIMIT),
            hasMore: cache.hasMore,
          })),
        );

      const persistMessage = (roomId: string, message: ChatMessage) =>
        persistence.persistMessage(roomId, encodeChatMessage(message)).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Failed to persist chat message", cause),
          ),
        );

      const broadcast = (text: string) =>
        Effect.forEach(sessions.values(), (peer) => peer.send(text), {
          concurrency: BROADCAST_CONCURRENCY,
        });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const roomId = roomIdFromRequestUrl(request.url);
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = crypto.randomUUID();

          socket.serializeAttachment({ id, roomId } satisfies Attachment);
          sessions.set(id, socket);

          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<Attachment>();
          if (!attachment) return;

          const maybeFrame = decodeClientFrame(textFromSocketMessage(message));
          if (Option.isNone(maybeFrame)) return;
          const frame = maybeFrame.value;

          if (frame._tag === "GetHistory") {
            const { messages, hasMore } = yield* loadHistory(attachment.roomId);
            yield* socket.send(
              encodeServerFrame({ _tag: "History", messages, hasMore }),
            );
            return;
          }

          if (frame._tag === "GetOlderHistory") {
            const { messages, hasMore } = yield* loadHistory(
              attachment.roomId,
              frame.cursor,
            );
            yield* socket.send(
              encodeServerFrame({ _tag: "OlderHistory", messages, hasMore }),
            );
            return;
          }

          const body = frame.body.trim();
          if (String_.isEmpty(body)) {
            return;
          }
          if (body.length > MAX_CHAT_MESSAGE_BODY_LENGTH) {
            // The shipped client enforces this client-side, so this only
            // fires for a non-standard client; still worth an explicit
            // signal rather than a silent drop.
            yield* socket.send(
              encodeServerFrame({
                _tag: "Rejected",
                reason: `Message exceeds ${MAX_CHAT_MESSAGE_BODY_LENGTH} characters.`,
              }),
            );
            return;
          }

          const chatMessage: ChatMessage = {
            id: crypto.randomUUID(),
            senderId: attachment.id,
            body,
            createdAt: yield* DateTime.now,
          };

          // Broadcast and persist concurrently: peers never wait on Postgres.
          yield* Effect.all(
            [
              broadcast(
                encodeServerFrame({ _tag: "Posted", message: chatMessage }),
              ),
              persistMessage(attachment.roomId, chatMessage),
            ],
            { concurrency: 2 },
          );

          yield* appendToHistory(chatMessage);
        }),
        webSocketClose: Effect.fn(function* (
          ws: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = ws.deserializeAttachment<Attachment>();
          if (attachment) sessions.delete(attachment.id);
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
