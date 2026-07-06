import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Neon.providers(),
  ),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!process.env.CI)(destroy(Stack));

const { getWhenReady } = Test;

const FRAME_TIMEOUT_MS = 30_000;

type ServerFrame =
  | {
      _tag: "History";
      messages: Array<{ body: string; senderId: string }>;
      hasMore: boolean;
    }
  | {
      _tag: "OlderHistory";
      messages: Array<{ body: string; senderId: string }>;
      hasMore: boolean;
    }
  | { _tag: "Posted"; message: { body: string; senderId: string } };

const chatSocketUrl = (chatUrl: string, roomId: string): string => {
  const url = new URL(chatUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(roomId)}`;
  return url.toString();
};

const withChatSession = <T>(
  socketUrl: string,
  session: (
    socket: WebSocket,
    nextFrame: () => Promise<ServerFrame>,
  ) => Promise<T>,
) =>
  Effect.tryPromise(async () => {
    const socket = new WebSocket(socketUrl);
    const pendingFrames: Array<ServerFrame> = [];
    const waiters: Array<(frame: ServerFrame) => void> = [];

    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        pendingFrames.push(frame);
      }
    });

    const nextFrame = () =>
      new Promise<ServerFrame>((resolve, reject) => {
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
  "chat service replays history, broadcasts posts, and persists them",
  Effect.gen(function* () {
    const { chatUrl } = yield* stack;
    yield* getWhenReady(chatUrl);

    const roomId = `integ-${Date.now()}`;
    const socketUrl = chatSocketUrl(chatUrl, roomId);
    const body = "Persisted through the Room durable object.";

    const posted = yield* withChatSession(
      socketUrl,
      async (socket, nextFrame) => {
        socket.send(JSON.stringify({ _tag: "GetHistory" }));
        const history = await nextFrame();
        expect(history._tag).toBe("History");
        if (history._tag === "History") {
          expect(history.messages).toHaveLength(0);
        }

        socket.send(JSON.stringify({ _tag: "Post", body }));

        const frame = await nextFrame();
        expect(frame._tag).toBe("Posted");
        return frame;
      },
    );

    if (posted._tag === "Posted") {
      expect(posted.message.body).toBe(body);
    }

    const replayed = yield* withChatSession(
      socketUrl,
      async (socket, nextFrame) => {
        socket.send(JSON.stringify({ _tag: "GetHistory" }));
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
