import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import {
  ClientFrame,
  ServerFrame,
  UserId,
} from "../backend/src/ChatProtocol.ts";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
  ),
  // Remote state in CI: runners are ephemeral, so with local state a failed
  // teardown strands resources with no record. With Cloudflare-backed state
  // the next run (all CI runs share the "test" stage, serialized by the
  // workflow's concurrency group) sees the leftovers and cleans them up.
  // Locally, keep state on disk so dev runs don't touch the shared record.
  state: process.env.CI ? Cloudflare.state() : Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

// Teardown must not leave paid resources behind, so ride out transient API
// failures (e.g. Cloudflare's ambiguous code-10000 "Authentication error"
// blips, which the client deliberately does not auto-retry). Destroy plans
// from state, so a retry only deletes whatever is still standing.
afterAll.skipIf(!process.env.CI)(
  destroy(Stack).pipe(
    Effect.retry({ times: 3, schedule: Schedule.spaced("10 seconds") }),
  ),
);

const { getWhenReady } = Test;

const FRAME_TIMEOUT_MS = 30_000;

// Seeded by migration alongside `random` and `feature-requests`; the chat
// service refuses sockets for rooms outside the `rooms` table.
const SEEDED_ROOM_ID = "general";

// The real wire schemas, not a hand-copied structural type: the test breaks
// if the protocol drifts, and decode failures surface as loud errors.
const decodeServerFrame = S.decodeUnknownSync(S.fromJsonString(ServerFrame));
const encodeClientFrame = S.encodeSync(S.fromJsonString(ClientFrame));
type ServerFrameType = typeof ServerFrame.Type;

// Bun's WebSocket accepts custom handshake headers (how the tests attach
// the session cookie a browser would send itself), but the DOM lib type of
// the constructor doesn't know the option.
const openSocket = (
  socketUrl: string,
  headers: Record<string, string>,
): WebSocket => new WebSocket(socketUrl, { headers } as unknown as string[]);

const chatSocketUrl = (chatUrl: string, roomId: string): string => {
  const url = new URL(chatUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(roomId)}`;
  return url.toString();
};

// Creates a real user through the auth API and returns the session cookie
// BetterAuth set, so the websocket handshake below authenticates the same
// way a browser would.
const signUpTestUser = (chatUrl: string) =>
  Effect.tryPromise(async () => {
    const email = `integ-${crypto.randomUUID()}@example.com`;
    const response = await fetch(new URL("/api/auth/sign-up/email", chatUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Integ Tester",
        email,
        password: "integ-password-123",
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Sign-up failed (${response.status}): ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { user: { id: string } };
    const cookie = response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; ");
    if (cookie === "") {
      throw new Error("Sign-up set no session cookie");
    }
    return { userId: UserId.make(payload.user.id), cookie };
  });

const withChatSession = <T>(
  socketUrl: string,
  cookie: string,
  session: (
    socket: WebSocket,
    nextFrame: () => Promise<ServerFrameType>,
  ) => Promise<T>,
) =>
  Effect.tryPromise(async () => {
    const socket = openSocket(socketUrl, { cookie });
    const pendingFrames: Array<ServerFrameType> = [];
    const waiters: Array<(frame: ServerFrameType) => void> = [];

    socket.addEventListener("message", (event) => {
      const frame = decodeServerFrame(String(event.data));
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        pendingFrames.push(frame);
      }
    });

    const nextFrame = () =>
      new Promise<ServerFrameType>((resolve, reject) => {
        const pending = pendingFrames.shift();
        if (pending) {
          resolve(pending);
          return;
        }
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for a chat frame")),
          FRAME_TIMEOUT_MS,
        );
        waiters.push((frame) => {
          clearTimeout(timeout);
          resolve(frame);
        });
      });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new Error("Failed to open chat socket")),
      );
    });

    try {
      return await session(socket, nextFrame);
    } finally {
      socket.close();
    }
  });

// Resolves true when the server refuses the handshake (401/403/404 all
// surface as a failed upgrade), false if the socket opens.
const socketRejected = (
  socketUrl: string,
  headers: Record<string, string>,
): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        const socket = openSocket(socketUrl, headers);
        socket.addEventListener("open", () => {
          socket.close();
          resolve(false);
        });
        socket.addEventListener("error", () => resolve(true));
      }),
    catch: (cause) => new Error(String(cause)),
  });

test(
  "stack exposes frontend, chat service, hyperdrive, and neon branch ids",
  Effect.gen(function* () {
    const { websiteUrl, chatUrl, branchId, hyperdriveId } = yield* stack;

    expect(websiteUrl).toBeString();
    expect(chatUrl).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

test(
  "gated routes reject anonymous and cross-origin callers",
  Effect.gen(function* () {
    const { chatUrl } = yield* stack;
    yield* getWhenReady(chatUrl);

    const anonymousRooms = yield* Effect.tryPromise(() =>
      fetch(new URL("/api/rooms", chatUrl)),
    );
    expect(anonymousRooms.status).toBe(401);

    const socketUrl = chatSocketUrl(chatUrl, SEEDED_ROOM_ID);
    expect(yield* socketRejected(socketUrl, {})).toBe(true);

    const { cookie } = yield* signUpTestUser(chatUrl);

    const rooms = yield* Effect.tryPromise(async () => {
      const response = await fetch(new URL("/api/rooms", chatUrl), {
        headers: { cookie },
      });
      return {
        status: response.status,
        body: (await response.json()) as unknown,
      };
    });
    expect(rooms.status).toBe(200);
    expect(rooms.body).toContain(SEEDED_ROOM_ID);

    // Cross-site WebSocket hijacking: a hostile page's socket carries the
    // victim's cookie but its own Origin, which the upgrade must refuse.
    expect(
      yield* socketRejected(socketUrl, {
        cookie,
        origin: "https://evil.example",
      }),
    ).toBe(true);

    // Unknown rooms are refused even with a valid session.
    expect(
      yield* socketRejected(chatSocketUrl(chatUrl, `missing-${Date.now()}`), {
        cookie,
      }),
    ).toBe(true);
  }),
  { timeout: 120_000 },
);

test(
  "chat service replays history, broadcasts posts, and persists them",
  Effect.gen(function* () {
    const { chatUrl } = yield* stack;
    yield* getWhenReady(chatUrl);

    const { userId, cookie } = yield* signUpTestUser(chatUrl);
    const socketUrl = chatSocketUrl(chatUrl, SEEDED_ROOM_ID);
    // The seeded room accumulates messages across runs, so assert on a
    // unique body rather than an empty history.
    const body = `Persisted through the Room durable object ${crypto.randomUUID()}`;

    const posted = yield* withChatSession(
      socketUrl,
      cookie,
      async (socket, nextFrame) => {
        socket.send(encodeClientFrame({ _tag: "GetHistory" }));
        const history = await nextFrame();
        expect(history._tag).toBe("History");

        socket.send(encodeClientFrame({ _tag: "Post", body }));

        const frame = await nextFrame();
        expect(frame._tag).toBe("Posted");
        return frame;
      },
    );

    if (posted._tag === "Posted") {
      expect(posted.message.body).toBe(body);
      // The sender identity comes from the session cookie, not the frame.
      expect(posted.message.senderId).toBe(userId);
    }

    const replayed = yield* withChatSession(
      socketUrl,
      cookie,
      async (socket, nextFrame) => {
        socket.send(encodeClientFrame({ _tag: "GetHistory" }));
        return nextFrame();
      },
    );

    expect(replayed._tag).toBe("History");
    if (replayed._tag === "History") {
      expect(replayed.messages.map((message) => message.body)).toContain(body);
    }
  }),
  { timeout: 120_000 },
);
