import * as S from "effect/Schema";

export const MAX_CHAT_MESSAGE_BODY_LENGTH = 2000;

// Headers ChatService uses to forward the verified session identity to the
// Room durable object (which is only reachable through ChatService).
export const USER_ID_HEADER = "x-chat-user-id";
export const USER_NAME_HEADER = "x-chat-user-name";

export const ChatMessage = S.Struct({
  id: S.String,
  senderId: S.String,
  senderName: S.String,
  body: S.String,
  createdAt: S.DateTimeUtcFromMillis,
});
export type ChatMessage = typeof ChatMessage.Type;

export const ChatHistoryCursor = S.Struct({
  beforeCreatedAtEpochMillis: S.Number,
  beforeId: S.String,
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
