import * as S from "effect/Schema";

export const MAX_TODO_TITLE_LENGTH = 200;

// We prefer to use branded types, nice Effect feature
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TodoId = S.String.check(S.isPattern(UUID_PATTERN)).pipe(
  S.brand("TodoId"),
);
export type TodoId = typeof TodoId.Type;

// Branded id: user ids are strings on the wire, so without the brand a
// swapped argument compiles and mis-routes at runtime.
export const UserId = S.NonEmptyString.pipe(S.brand("UserId"));
export type UserId = typeof UserId.Type;

// The wire type is this schema's encoded form: `createdAt` is epoch millis
// there (`S.DateTimeUtcFromMillis`), which is what the API responds with.
export const Todo = S.Struct({
  id: TodoId,
  title: S.String,
  completed: S.Boolean,
  createdAt: S.DateTimeUtcFromMillis,
});
export type Todo = typeof Todo.Type;

export const CreateTodoRequest = S.Struct({
  title: S.String,
});
export type CreateTodoRequest = typeof CreateTodoRequest.Type;

export const UpdateTodoRequest = S.Struct({
  completed: S.Boolean,
});
export type UpdateTodoRequest = typeof UpdateTodoRequest.Type;
