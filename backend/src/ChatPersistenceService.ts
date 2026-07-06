import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { and, desc, eq, lt, or } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ChatHistoryCursor } from "./ChatProtocol.ts";
import { Hyperdrive } from "./Db.ts";
import { ChatMessages, type ChatMessageRow } from "./schema.ts";

export const PersistedChatMessage = S.Struct({
  id: S.String,
  roomId: S.String,
  senderId: S.String,
  body: S.String,
  createdAtEpochMillis: S.Number,
});
export type PersistedChatMessage = typeof PersistedChatMessage.Type;

export const PersistedChatHistoryPage = S.Struct({
  messages: S.Array(PersistedChatMessage),
  hasMore: S.Boolean,
});
export type PersistedChatHistoryPage = typeof PersistedChatHistoryPage.Type;

type ChatPersistenceServiceApi = {
  persistMessage: (message: PersistedChatMessage) => Effect.Effect<void>;
  getRoomHistory: (
    roomId: string,
    limit: number,
    cursor?: ChatHistoryCursor,
  ) => Effect.Effect<PersistedChatHistoryPage>;
};

const toPersistedChatMessage = (
  row: ChatMessageRow,
): PersistedChatMessage => ({
  id: row.id,
  roomId: row.roomId,
  senderId: row.senderId,
  body: row.body,
  createdAtEpochMillis: row.createdAt.getTime(),
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

      persistMessage: (message: PersistedChatMessage) =>
        Effect.gen(function* () {
          yield* db.insert(ChatMessages).values({
            id: message.id,
            roomId: message.roomId,
            senderId: message.senderId,
            body: message.body,
            createdAt: new Date(message.createdAtEpochMillis),
          });
        }),

      getRoomHistory: (
        roomId: string,
        limit: number,
        cursor?: ChatHistoryCursor,
      ) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(ChatMessages)
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
            messages: rows.slice(0, limit).map(toPersistedChatMessage).reverse(),
            hasMore: rows.length > limit,
          };
        }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
