import * as Cloudflare from "alchemy/Cloudflare";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as M from "effect/Match";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as String_ from "effect/String";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  ChatMessage,
  MessageId,
  RoomId,
  UserId,
  type ChatHistoryCursor,
  ClientFrame,
  MAX_CHAT_MESSAGE_BODY_LENGTH,
  ServerFrame,
  USER_ID_HEADER,
  USER_NAME_HEADER,
} from "./ChatProtocol.ts";
import ChatPersistenceService, {
  type PersistedChatMessage,
} from "./ChatPersistenceService.ts";

// Relevant: https://v2.alchemy.run/cloudflare/compute/hibernatable-websockets/#_top

const HISTORY_LIMIT = 50;
const BROADCAST_CONCURRENCY = 32;

// Outbox flush cadence, messages get written to DO SQLite immediately
// the alarm archives them to Postgres in batches. The delay is a batching
// window, not a durability window — a longer delay only trades Hyperdrive
// round trips against how long the archive lags the room.
const FLUSH_DELAY_MS = 1_000;
const FLUSH_RETRY_DELAY_MS = 5_000;
const FLUSH_BATCH_SIZE = 100;

const decodeClientFrame = S.decodeUnknownOption(S.fromJsonString(ClientFrame));
const encodeServerFrame = S.encodeSync(S.fromJsonString(ServerFrame));

// The persistence wire format is `ChatMessage`'s encoded form, so the schema
// codec is the whole mapping layer between the socket and the database.
const decodeChatMessage = S.decodeSync(ChatMessage);
const encodeChatMessage = S.encodeSync(ChatMessage);

// `socketId` keys the in-memory session map (one user may hold several
// sockets across tabs); `userId`/`userName` are the verified identity that
// ChatService resolved from the session cookie on upgrade.
type Attachment = {
  socketId: string;
  userId: UserId;
  userName: string;
};

type HistoryCache = {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly hasMore: boolean;
};

// socket messages can be ArrayBuffer or string
const textFromSocketMessage = (message: string | ArrayBuffer): string =>
  typeof message === "string" ? message : new TextDecoder().decode(message);

export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const persistence = yield* Cloudflare.Workers.bindWorker(
      ChatPersistenceService,
    );

    return Effect.gen(function* () {
      // The room id is the name this DO was looked up by (`rooms.getByName`
      // in ChatService). `.name` is only absent for ids minted with
      // `newUniqueId`, which this app never uses — so its absence is a
      // wiring bug worth dying on, not a request to limp through.
      const name = state.id.name;
      if (name === undefined) {
        return yield* Effect.die(
          new Error("Room DO activated without a named id"),
        );
      }
      const roomId = RoomId.make(name);

      const sessions = new Map<string, Cloudflare.WebSocket>();
      // Rebuilt from Postgres on the first join after each activation; kept
      // current in memory afterwards so joins don't hit the database.
      const historyCache = yield* Ref.make(Option.none<HistoryCache>());

      // Write-ahead outbox in the DO's own SQLite: the same-thread insert is
      // the durability commit point, and an alarm drains it to Postgres in
      // batches. Rows are deleted only after the archive write succeeds.
      yield* state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY,
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<Attachment>();
        if (data) sessions.set(data.socketId, socket);
      }

      const loadHistory = (cursor?: ChatHistoryCursor) =>
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
          const archived = Array.map(page.messages, (message) =>
            decodeChatMessage(message),
          );
          if (cursor !== undefined) {
            yield* Ref.update(
              historyCache,
              Option.map((existing) => ({
                messages: [...archived, ...existing.messages],
                hasMore: page.hasMore,
              })),
            );
            return { messages: archived, hasMore: page.hasMore };
          }
          // The freshest messages may still be in the outbox (not yet
          // archived to Postgres), so the initial page overlays them —
          // otherwise history would appear to lose recent messages whenever
          // the DO restarts mid-flush or during a Postgres outage.
          const pendingRows = yield* readOutbox(HISTORY_LIMIT);
          const archivedIds = new Set(
            Array.map(archived, (message) => message.id),
          );
          const pending = pendingRows
            .filter((row) => !archivedIds.has(MessageId.make(row.id)))
            .map((row) =>
              decodeChatMessage(
                JSON.parse(row.message) as PersistedChatMessage,
              ),
            );
          const combined = [...archived, ...pending];
          const result: HistoryCache = {
            messages: combined.slice(-HISTORY_LIMIT),
            hasMore: page.hasMore || combined.length > HISTORY_LIMIT,
          };
          yield* Ref.set(historyCache, Option.some(result));
          return result;
        });

      const appendToHistory = (message: ChatMessage) =>
        Ref.update(
          historyCache,
          Option.map((cache) => {
            const messages = [...cache.messages, message];
            return {
              messages: messages.slice(-HISTORY_LIMIT),
              hasMore: cache.hasMore || messages.length > HISTORY_LIMIT,
            };
          }),
        );

      const readOutbox = (limit: number) =>
        Effect.flatMap(
          state.storage.sql.exec<{
            id: string;
            message: string;
          }>(
            "SELECT id, message FROM outbox ORDER BY created_at, id LIMIT ?",
            limit,
          ),
          (cursor) => cursor.toArray(),
        );

      // A DO holds exactly one alarm, so only arm it when none is pending —
      // setAlarm overwrites, and pushing the deadline back on every message
      // would starve the flush under sustained traffic.
      const scheduleFlush = (delayMs: number) =>
        Effect.gen(function* () {
          const pending = yield* state.storage.getAlarm();
          if (pending === null) {
            yield* state.storage.setAlarm(Date.now() + delayMs);
          }
        });

      const enqueueForArchive = (message: ChatMessage) =>
        Effect.gen(function* () {
          const encoded = encodeChatMessage(message);
          yield* state.storage.sql.exec(
            "INSERT INTO outbox (id, message, created_at) VALUES (?, ?, ?)",
            encoded.id,
            JSON.stringify(encoded),
            encoded.createdAt,
          );
          yield* scheduleFlush(FLUSH_DELAY_MS);
        });

      const flushOutbox = Effect.gen(function* () {
        const rows = yield* readOutbox(FLUSH_BATCH_SIZE);
        if (!Array.isReadonlyArrayNonEmpty(rows)) return;
        yield* persistence.persistMessages(
          roomId,
          Array.map(
            rows,
            (row) => JSON.parse(row.message) as PersistedChatMessage,
          ),
        );
        yield* state.storage.sql.exec(
          `DELETE FROM outbox WHERE id IN (${rows.map(() => "?").join(", ")})`,
          ...rows.map((row) => row.id),
        );
        if (rows.length === FLUSH_BATCH_SIZE) {
          yield* scheduleFlush(0);
        }
      });

      const broadcast = (text: string) =>
        Effect.forEach(sessions.values(), (peer) => peer.send(text), {
          concurrency: BROADCAST_CONCURRENCY,
        });

      const postMessage = (
        socket: Cloudflare.WebSocket,
        attachment: Attachment,
        rawBody: string,
      ) =>
        Effect.gen(function* () {
          const body = rawBody.trim();
          if (String_.isEmpty(body)) {
            return;
          }
          if (body.length > MAX_CHAT_MESSAGE_BODY_LENGTH) {
            // Should be handled by our client, for completeness keep this
            yield* socket.send(
              encodeServerFrame({
                _tag: "Rejected",
                reason: `Message exceeds ${MAX_CHAT_MESSAGE_BODY_LENGTH} characters.`,
              }),
            );
            return;
          }

          const chatMessage: ChatMessage = {
            id: MessageId.make(crypto.randomUUID()),
            senderId: attachment.userId,
            senderName: attachment.userName,
            body,
            createdAt: yield* DateTime.now,
          };

          // Durability first: the outbox insert is the commit point, and it
          // runs same-thread against DO SQLite so it can't fail independently
          // of the DO itself. Only after it succeeds does anyone — including
          // the sender and the history cache — see the message.
          yield* enqueueForArchive(chatMessage);
          yield* broadcast(
            encodeServerFrame({ _tag: "Posted", message: chatMessage }),
          );
          yield* appendToHistory(chatMessage);
        });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Identity is stamped on the request by ChatService after cookie
          // validation; a request without it never went through the gate.
          const userId = request.headers[USER_ID_HEADER];
          const encodedUserName = request.headers[USER_NAME_HEADER];
          if (userId === undefined || encodedUserName === undefined) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          const socketId = crypto.randomUUID();

          socket.serializeAttachment({
            socketId,
            userId: UserId.make(userId),
            userName: decodeURIComponent(encodedUserName),
          } satisfies Attachment);
          sessions.set(socketId, socket);

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

          yield* M.value(maybeFrame.value).pipe(
            M.tagsExhaustive({
              GetHistory: () =>
                Effect.gen(function* () {
                  const { messages, hasMore } = yield* loadHistory();
                  yield* socket.send(
                    encodeServerFrame({ _tag: "History", messages, hasMore }),
                  );
                }),
              GetOlderHistory: ({ cursor }) =>
                Effect.gen(function* () {
                  const { messages, hasMore } = yield* loadHistory(cursor);
                  yield* socket.send(
                    encodeServerFrame({
                      _tag: "OlderHistory",
                      messages,
                      hasMore,
                    }),
                  );
                }),
              Post: ({ body }) => postMessage(socket, attachment, body),
            }),
          );
        }),
        alarm: () =>
          flushOutbox.pipe(
            // Archive failures surface as defects (the RPC surface is typed
            // unfailable), so sandbox to expose the cause for retry. Quick
            // retries cover transient blips; a real outage falls through to
            // a rescheduled alarm, and the outbox keeps everything until a
            // flush finally lands.
            Effect.sandbox,
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("250 millis"),
            }),
            Effect.catchCause((cause) =>
              Effect.logError("Outbox flush failed; will retry", cause).pipe(
                Effect.andThen(scheduleFlush(FLUSH_RETRY_DELAY_MS)),
              ),
            ),
          ),
        webSocketClose: Effect.fn(function* (
          ws: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = ws.deserializeAttachment<Attachment>();
          if (attachment) sessions.delete(attachment.socketId);
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
