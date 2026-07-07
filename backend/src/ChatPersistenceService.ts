import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { and, desc, eq, lt, or } from "drizzle-orm";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { ChatHistoryCursor, ChatMessage } from "./ChatProtocol.ts";
import { Hyperdrive } from "./Db.ts";
import { ChatMessages, Rooms, User } from "./schema.ts";

// The wire type is the `ChatMessage` schema's encoded form: `createdAt` is
// epoch millis there (`S.DateTimeUtcFromMillis`), which survives the
// structured-clone RPC boundary where a `DateTime.Utc` instance would not.
export type PersistedChatMessage = typeof ChatMessage.Encoded;

export type PersistedChatHistoryPage = {
  readonly messages: ReadonlyArray<PersistedChatMessage>;
  readonly hasMore: boolean;
};

type ChatPersistenceServiceApi = {
  persistMessage: (
    roomId: string,
    message: PersistedChatMessage,
  ) => Effect.Effect<void>;
  // NOTE: `cursor` is a plain optional parameter rather than an `Option`
  // because arguments cross the worker RPC boundary via structured clone,
  // which `Option` class instances don't survive.
  getRoomHistory: (
    roomId: string,
    limit: number,
    cursor?: ChatHistoryCursor,
  ) => Effect.Effect<PersistedChatHistoryPage>;
  listRooms: () => Effect.Effect<ReadonlyArray<string>>;
};

type HistoryRow = {
  id: string;
  senderId: string;
  senderName: string | null;
  body: string;
  createdAt: Date;
};

const toPersistedChatMessage = (row: HistoryRow): PersistedChatMessage => ({
  id: row.id,
  senderId: row.senderId,
  // The FK is ON DELETE CASCADE so a null join result shouldn't happen, but
  // a placeholder beats failing the whole history page if it ever does.
  senderName: row.senderName ?? "unknown",
  body: row.body,
  createdAt: row.createdAt.getTime(),
});

export default class ChatPersistenceService extends Cloudflare.Worker<ChatPersistenceServiceApi>()(
  "ChatPersistenceService",
  {
    main: import.meta.url,
    url: false,
    dev: { port: 1336, strictPort: true },
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString);

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),

      persistMessage: (roomId: string, message: PersistedChatMessage) =>
        Effect.gen(function* () {
          yield* db.insert(ChatMessages).values({
            id: message.id,
            roomId,
            senderId: message.senderId,
            body: message.body,
            createdAt: new Date(message.createdAt),
          });
        }),

      getRoomHistory: (
        roomId: string,
        limit: number,
        cursor?: ChatHistoryCursor,
      ) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: ChatMessages.id,
              senderId: ChatMessages.senderId,
              senderName: User.name,
              body: ChatMessages.body,
              createdAt: ChatMessages.createdAt,
            })
            .from(ChatMessages)
            .leftJoin(User, eq(ChatMessages.senderId, User.id))
            .where(
              and(
                eq(ChatMessages.roomId, roomId),
                cursor
                  ? or(
                      lt(
                        ChatMessages.createdAt,
                        new Date(cursor.beforeCreatedAtEpochMillis),
                      ),
                      and(
                        eq(
                          ChatMessages.createdAt,
                          new Date(cursor.beforeCreatedAtEpochMillis),
                        ),
                        lt(ChatMessages.id, cursor.beforeId),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(ChatMessages.createdAt), desc(ChatMessages.id))
            .limit(limit + 1);
          return {
            messages: pipe(
              rows,
              Array.take(limit),
              Array.map(toPersistedChatMessage),
              Array.reverse,
            ),
            hasMore: rows.length > limit,
          };
        }),

      listRooms: () =>
        Effect.gen(function* () {
          const rows = yield* db.select({ id: Rooms.id }).from(Rooms);
          return Array.map(rows, (row) => row.id);
        }),
    };
    // `Layer.fresh` for the same reason as in ChatService.ts: the layer
    // build is memoized globally and captures its host worker.
  }).pipe(Effect.provide(Layer.fresh(Cloudflare.Hyperdrive.ConnectBinding))),
) {}
