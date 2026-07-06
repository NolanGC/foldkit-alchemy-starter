import { Effect, Option, Schema as S } from "effect";
import { Command } from "foldkit";
import { m } from "foldkit/message";

import { CHAT_SERVICE_URL } from "./config";

// The client-side session is a cached copy of the user profile; the actual
// authority is the http-only cookie BetterAuth set, which the server
// validates on every gated request.
export const Session = S.Struct({
  userId: S.String,
  email: S.String,
  name: S.String,
});
export type Session = typeof Session.Type;

const SESSION_STORAGE_KEY = "foldkit-chat-session";

// MESSAGE

export const GotSession = m("GotSession", {
  maybeSession: S.Option(Session),
});
export const FailedCheckSession = m("FailedCheckSession", { error: S.String });
export const SucceededAuth = m("SucceededAuth", { session: Session });
export const FailedAuth = m("FailedAuth", { error: S.String });
export const CompletedSignOut = m("CompletedSignOut");
export const CompletedSessionPersistence = m("CompletedSessionPersistence");

// API

const UserPayload = S.Struct({
  user: S.Struct({ id: S.String, email: S.String, name: S.String }),
});
const decodeUserPayload = S.decodeUnknownOption(UserPayload);

const toSession = (payload: typeof UserPayload.Type): Session => ({
  userId: payload.user.id,
  email: payload.user.email,
  name: payload.user.name,
});

// All BetterAuth endpoints are cookie-authenticated, so every call must be
// credentialed — that's what makes the browser attach/store the session
// cookie across the frontend/chat-service origin split.
const authFetch = (path: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(new URL(path, CHAT_SERVICE_URL), {
      credentials: "include",
      ...init,
    });
    const body: unknown = await response.json().catch(() => null);
    return { response, body };
  });

const errorMessage = (body: unknown, fallback: string): string => {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return fallback;
};

const postJson = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// COMMAND

// Asks the server who the cookie belongs to. This is the boot-time
// authority; the localStorage copy only provides instant first paint.
export const CheckSession = Command.define(
  "CheckSession",
  GotSession,
  FailedCheckSession,
)(
  authFetch("/api/auth/get-session").pipe(
    Effect.map(({ body }) =>
      GotSession({
        maybeSession: Option.map(decodeUserPayload(body), toSession),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedCheckSession({ error: String(error) })),
    ),
  ),
);

export const SignIn = Command.define(
  "SignIn",
  { email: S.String, password: S.String },
  SucceededAuth,
  FailedAuth,
)(({ email, password }) =>
  authFetch("/api/auth/sign-in/email", postJson({ email, password })).pipe(
    Effect.map(({ response, body }) =>
      Option.match(response.ok ? decodeUserPayload(body) : Option.none(), {
        onNone: () =>
          FailedAuth({
            error: errorMessage(body, "Sign in failed."),
          }),
        onSome: (payload) => SucceededAuth({ session: toSession(payload) }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedAuth({ error: String(error) })),
    ),
  ),
);

export const SignUp = Command.define(
  "SignUp",
  { name: S.String, email: S.String, password: S.String },
  SucceededAuth,
  FailedAuth,
)(({ name, email, password }) =>
  authFetch(
    "/api/auth/sign-up/email",
    postJson({ name, email, password }),
  ).pipe(
    Effect.map(({ response, body }) =>
      Option.match(response.ok ? decodeUserPayload(body) : Option.none(), {
        onNone: () =>
          FailedAuth({
            error: errorMessage(body, "Sign up failed."),
          }),
        onSome: (payload) => SucceededAuth({ session: toSession(payload) }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedAuth({ error: String(error) })),
    ),
  ),
);

// Sign-out is best-effort: the client drops its state either way, and the
// server-side session expires on its own if the request never lands.
export const SignOut = Command.define(
  "SignOut",
  CompletedSignOut,
)(
  authFetch("/api/auth/sign-out", postJson({})).pipe(
    Effect.ignore,
    Effect.as(CompletedSignOut()),
  ),
);

// SESSION CACHE (localStorage)

const encodeSession = S.encodeSync(S.fromJsonString(Session));
const decodeStoredSession = S.decodeUnknownOption(S.fromJsonString(Session));

export const readStoredSession = Effect.sync(
  (): Option.Option<Session> =>
    Option.flatMap(
      Option.fromNullishOr(localStorage.getItem(SESSION_STORAGE_KEY)),
      decodeStoredSession,
    ),
).pipe(Effect.catch(() => Effect.succeedNone));

export const SaveSession = Command.define(
  "SaveSession",
  { session: Session },
  CompletedSessionPersistence,
)(({ session }) =>
  Effect.sync(() =>
    localStorage.setItem(SESSION_STORAGE_KEY, encodeSession(session)),
  ).pipe(Effect.ignore, Effect.as(CompletedSessionPersistence())),
);

export const ClearSession = Command.define(
  "ClearSession",
  CompletedSessionPersistence,
)(
  Effect.sync(() => localStorage.removeItem(SESSION_STORAGE_KEY)).pipe(
    Effect.ignore,
    Effect.as(CompletedSessionPersistence()),
  ),
);
