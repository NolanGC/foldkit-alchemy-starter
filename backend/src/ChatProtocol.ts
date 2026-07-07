import * as S from "effect/Schema";

export const MAX_CHAT_MESSAGE_BODY_LENGTH = 2000;

// Headers ChatService uses to forward the verified session identity to the
// Room durable object (which is only reachable through ChatService).
export const USER_ID_HEADER = "x-chat-user-id";
export const USER_NAME_HEADER = "x-chat-user-name";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MessageId = S.String.check(S.isPattern(UUID_PATTERN)).pipe(
  S.brand("MessageId"),
);
export type MessageId = typeof MessageId.Type;

// Branded ids: rooms, users, and messages are all strings on the wire, so
// without brands a swapped argument compiles and mis-routes at runtime.
export const RoomId = S.NonEmptyString.pipe(S.brand("RoomId"));
export type RoomId = typeof RoomId.Type;

export const UserId = S.NonEmptyString.pipe(S.brand("UserId"));
export type UserId = typeof UserId.Type;

export const ChatMessage = S.Struct({
  id: MessageId,
  senderId: UserId,
  senderName: S.String,
  body: S.String,
  createdAt: S.DateTimeUtcFromMillis,
});
export type ChatMessage = typeof ChatMessage.Type;

export const ChatHistoryCursor = S.Struct({
  beforeCreatedAtEpochMillis: S.Number,
  beforeId: MessageId,
});
export type ChatHistoryCursor = typeof ChatHistoryCursor.Type;

export const HistoryFrame = S.TaggedStruct("History", {
  messages: S.Array(ChatMessage),
  hasMore: S.Boolean,
});
export type HistoryFrame = typeof HistoryFrame.Type;

export const OlderHistoryFrame = S.TaggedStruct("OlderHistory", {
  messages: S.Array(ChatMessage),
  hasMore: S.Boolean,
});
export type OlderHistoryFrame = typeof OlderHistoryFrame.Type;

export const PostedFrame = S.TaggedStruct("Posted", {
  message: ChatMessage,
});
export type PostedFrame = typeof PostedFrame.Type;

export const RejectedFrame = S.TaggedStruct("Rejected", {
  reason: S.String,
});
export type RejectedFrame = typeof RejectedFrame.Type;

export const ServerFrame = S.Union([
  HistoryFrame,
  OlderHistoryFrame,
  PostedFrame,
  RejectedFrame,
]);
export type ServerFrame = typeof ServerFrame.Type;

export const PostFrame = S.TaggedStruct("Post", {
  body: S.String,
});
export type PostFrame = typeof PostFrame.Type;

export const GetHistoryFrame = S.TaggedStruct("GetHistory", {});
export type GetHistoryFrame = typeof GetHistoryFrame.Type;

export const GetOlderHistoryFrame = S.TaggedStruct("GetOlderHistory", {
  cursor: ChatHistoryCursor,
});
export type GetOlderHistoryFrame = typeof GetOlderHistoryFrame.Type;

export const ClientFrame = S.Union([
  PostFrame,
  GetHistoryFrame,
  GetOlderHistoryFrame,
]);
export type ClientFrame = typeof ClientFrame.Type;
