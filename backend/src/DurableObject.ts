import * as Cloudflare from "alchemy/Cloudflare";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  type ChatHistoryCursor,
  ClientFrame,
  MAX_CHAT_MESSAGE_BODY_LENGTH,
  ServerFrame,
  type ChatMessage,
} from "./ChatProtocol.ts";
import ChatPersistenceService, {
  type PersistedChatMessage,
} from "./ChatPersistenceService.ts";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

const HISTORY_LIMIT = 50;
const BROADCAST_CONCURRENCY = 32;

const decodeClientFrame = S.decodeUnknownOption(S.fromJsonString(ClientFrame));
const encodeServerFrame = S.encodeSync(S.fromJsonString(ServerFrame));

type Attachment = { id: string; roomId: string };

const textFromSocketMessage = (message: string | ArrayBuffer): string =>
  typeof message === "string" ? message : new TextDecoder().decode(message);

const toChatMessage = (message: PersistedChatMessage): ChatMessage => ({
  id: message.id,
  senderId: message.senderId,
  body: message.body,
  createdAt: DateTime.makeUnsafe(message.createdAtEpochMillis),
});

const toPersistedChatMessage = (
  roomId: string,
  message: ChatMessage,
): PersistedChatMessage => ({
  id: message.id,
  roomId,
  senderId: message.senderId,
  body: message.body,
  createdAtEpochMillis: DateTime.toEpochMillis(message.createdAt),
});

const roomIdFromRequestUrl = (url: string): string =>
  decodeURIComponent(
    new URL(url, "http://chat").pathname.split("/").filter(Boolean).at(-1) ??
      "general",
  );

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
      let cachedHistory: ReadonlyArray<ChatMessage> | undefined;
      let cachedHistoryHasMore = false;

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<Attachment>();
        if (data) sessions.set(data.id, socket);
      }

      const loadHistory = (roomId: string, cursor?: ChatHistoryCursor) =>
        Effect.gen(function* () {
          if (!cursor && cachedHistory) {
            return { messages: cachedHistory, hasMore: cachedHistoryHasMore };
          }
          const page = yield* persistence.getRoomHistory(
            roomId,
            HISTORY_LIMIT,
            cursor,
          );
          const messages = page.messages.map(toChatMessage);
          if (!cursor) {
            cachedHistory = messages;
            cachedHistoryHasMore = page.hasMore;
          } else if (cachedHistory) {
            cachedHistory = [...messages, ...cachedHistory];
            cachedHistoryHasMore = page.hasMore;
          }
          return { messages, hasMore: page.hasMore };
        });

      const appendToHistory = (message: ChatMessage) => {
        if (cachedHistory) {
          cachedHistory = [...cachedHistory, message].slice(-HISTORY_LIMIT);
        }
      };

      const persistMessage = (roomId: string, message: ChatMessage) =>
        persistence
          .persistMessage(toPersistedChatMessage(roomId, message))
          .pipe(
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
          if (body.length === 0 || body.length > MAX_CHAT_MESSAGE_BODY_LENGTH) {
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

          appendToHistory(chatMessage);
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
