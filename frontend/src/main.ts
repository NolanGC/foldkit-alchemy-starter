import { Array, Cause, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, ManagedResource, Runtime, Subscription } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { CHAT_SERVICE_URL } from "./config";
import { Chat } from "./page";
import { AppRoute, chatRouter, homeRouter, urlToAppRoute } from "./route";

const DEFAULT_ROOM_ID = "general";

// MODEL

// The set of valid rooms lives in Postgres, so the client fetches it at boot
// and models it as remote data: nav tabs render from it, and chat routes for
// rooms outside it show "Room not found" instead of connecting.
export const RoomsLoading = ts("RoomsLoading");
export const RoomsFailed = ts("RoomsFailed", { error: S.String });
export const RoomsLoaded = ts("RoomsLoaded", {
  roomIds: S.Array(S.NonEmptyString),
});

const RoomsState = S.Union([RoomsLoading, RoomsFailed, RoomsLoaded]);
type RoomsState = typeof RoomsState.Type;

export const Model = S.Struct({
  route: AppRoute,
  rooms: RoomsState,
  chatPage: Chat.Model,
});
export type Model = typeof Model.Type;

// MESSAGE

export const CompletedNavigateInternal = m("CompletedNavigateInternal");
export const CompletedLoadExternal = m("CompletedLoadExternal");
export const ClickedLink = m("ClickedLink", {
  request: UrlRequest,
});
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const GotRooms = m("GotRooms", {
  roomIds: S.Array(S.NonEmptyString),
});
export const FailedFetchRooms = m("FailedFetchRooms", { error: S.String });
export const GotChatMessage = m("GotChatMessage", {
  message: Chat.Message,
});

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
  GotRooms,
  FailedFetchRooms,
  GotChatMessage,
]);
export type Message = typeof Message.Type;

// INIT

const routeRoomId = (route: AppRoute): string =>
  route._tag === "Chat" ? route.roomId : DEFAULT_ROOM_ID;

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => {
  const route = urlToAppRoute(url);

  return [
    {
      route,
      rooms: RoomsLoading(),
      chatPage: Chat.init(routeRoomId(route)),
    },
    [FetchRooms()],
  ];
};

// COMMAND

const NavigateInternal = Command.define(
  "NavigateInternal",
  { url: S.String },
  CompletedNavigateInternal,
)(({ url }) => pushUrl(url).pipe(Effect.as(CompletedNavigateInternal())));

const LoadExternal = Command.define(
  "LoadExternal",
  { href: S.String },
  CompletedLoadExternal,
)(({ href }) => load(href).pipe(Effect.as(CompletedLoadExternal())));

const decodeRoomIds = S.decodeUnknownOption(S.Array(S.NonEmptyString));

const FetchRooms = Command.define(
  "FetchRooms",
  GotRooms,
  FailedFetchRooms,
)(
  Effect.tryPromise(async () => {
    const response = await fetch(new URL("/api/rooms", CHAT_SERVICE_URL));
    if (!response.ok) {
      throw new Error(`Failed to load rooms (${response.status})`);
    }
    return (await response.json()) as unknown;
  }).pipe(
    Effect.map((payload) =>
      Option.match(decodeRoomIds(payload), {
        onNone: () => FailedFetchRooms({ error: "Unexpected rooms payload" }),
        onSome: (roomIds) => GotRooms({ roomIds }),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.succeed(FailedFetchRooms({ error: Cause.pretty(cause) })),
    ),
  ),
);

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, Chat.ChatSocketService>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      CompletedNavigateInternal: () => [model, []],
      CompletedLoadExternal: () => [model, []],

      ClickedLink: ({ request }) =>
        M.value(request).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            Internal: ({ url }) => [
              model,
              [NavigateInternal({ url: urlToString(url) })],
            ],
            External: ({ href }) => [model, [LoadExternal({ href })]],
          }),
        ),

      ChangedUrl: ({ url }) => {
        const route = urlToAppRoute(url);

        return [
          evo(model, {
            route: () => route,
            chatPage: (chatPage) =>
              route._tag === "Chat"
                ? Chat.connect(chatPage, route.roomId)
                : chatPage,
          }),
          [],
        ];
      },

      GotRooms: ({ roomIds }) => [
        evo(model, { rooms: () => RoomsLoaded({ roomIds }) }),
        [],
      ],

      FailedFetchRooms: ({ error }) => [
        evo(model, { rooms: () => RoomsFailed({ error }) }),
        [],
      ],

      GotChatMessage: ({ message }) => {
        const [chatPage, commands] = Chat.update(model.chatPage, message);

        return [
          evo(model, { chatPage: () => chatPage }),
          Command.mapMessages(commands, (message) =>
            GotChatMessage({ message }),
          ),
        ];
      },
    }),
  );

// MANAGED RESOURCES

// A room is only known to be invalid once the room list has loaded; until
// then the socket connects optimistically (the server refuses unknown rooms
// anyway) so valid rooms never wait on the rooms fetch.
const isUnknownRoom = (model: Model): boolean =>
  model.route._tag === "Chat" &&
  model.rooms._tag === "RoomsLoaded" &&
  !Array.contains(model.rooms.roomIds, model.route.roomId);

export const managedResources = ManagedResource.lift(Chat.managedResources)<
  Model,
  Message
>({
  toChildModel: (model) =>
    model.route._tag === "Chat" && !isUnknownRoom(model)
      ? Option.some(model.chatPage)
      : Option.none(),
  toParentMessage: (message) => GotChatMessage({ message }),
});

// SUBSCRIPTIONS

export const subscriptions = Subscription.lift(Chat.subscriptions)<
  Model,
  Message
>({
  toChildModel: (model) => model.chatPage,
  toParentMessage: (message) => GotChatMessage({ message }),
});

// VIEW

const isActiveRoom = (route: AppRoute, roomId: string): boolean =>
  route._tag === "Chat" && route.roomId === roomId;

const navigationView = (currentRoute: AppRoute, rooms: RoomsState): Html => {
  const h = html<Message>();

  const linkClassName = (isActive: boolean) =>
    `px-3 py-2 text-sm font-medium ${isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;

  const roomIds = rooms._tag === "RoomsLoaded" ? rooms.roomIds : [];

  return h.nav(
    [h.Class("border-b border-neutral-900")],
    [
      h.ul(
        [h.Class("mx-auto flex max-w-5xl items-center gap-2 px-4 py-3")],
        [
          h.li(
            [h.Class("mr-4 text-sm font-bold uppercase text-neutral-400")],
            [h.a([h.Href(homeRouter())], ["Foldkit Chat"])],
          ),
          ...Array.map(roomIds, (roomId) =>
            h.li(
              [],
              [
                h.a(
                  [
                    h.Href(chatRouter({ roomId })),
                    h.Class(linkClassName(isActiveRoom(currentRoute, roomId))),
                  ],
                  [`#${roomId}`],
                ),
              ],
            ),
          ),
        ],
      ),
    ],
  );
};

export const view = (model: Model): Document => {
  const h = html<Message>();

  if (model.route._tag === "Home") {
    return { title: "FoldkitChat", body: landingView() };
  }

  const routeContent = M.value(model.route).pipe(
    M.tagsExhaustive({
      NotFound: ({ path }) =>
        notFoundView("Page not found", `No route for ${path}.`),
      Chat: ({ roomId }) =>
        isUnknownRoom(model)
          ? notFoundView("Room not found", `There is no #${roomId} room.`)
          : chatView(model),
    }),
  );

  return {
    title: routeTitle(model),
    body: h.div(
      [
        h.Class(
          "flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100",
        ),
      ],
      [
        navigationView(model.route, model.rooms),
        h.keyed("main")(
          routeKey(model),
          [h.Class("min-h-0 flex-1 overflow-hidden")],
          [routeContent],
        ),
      ],
    ),
  };
};

const landingView = (): Html => {
  const h = html<Message>();

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 px-6 py-24 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-xl")],
        [
          h.h1([h.Class("text-3xl font-bold")], ["FoldkitChat"]),
          h.p(
            [h.Class("mt-3 text-neutral-400")],
            [
              "A simple live chat app built end-to-end using Effect, using Foldkit and Alchemy.",
            ],
          ),
          h.a(
            [
              h.Href(chatRouter({ roomId: DEFAULT_ROOM_ID })),
              h.Class("mt-8 inline-block underline underline-offset-4"),
            ],
            ["Enter chat →"],
          ),
        ],
      ),
    ],
  );
};

const chatView = (model: Model): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "chat",
    model: model.chatPage,
    view: Chat.view,
    toParentMessage: (message) => GotChatMessage({ message }),
  });
};

const notFoundView = (heading: string, detail: string): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.div(
        [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
        [
          h.h1([h.Class("text-2xl font-bold")], [heading]),
          h.p([h.Class("mt-2 text-neutral-400")], [detail]),
          h.a(
            [
              h.Href(homeRouter()),
              h.Class(
                "mt-4 inline-block border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
              ),
            ],
            ["Back home"],
          ),
        ],
      ),
    ],
  );
};

const routeTitle = (model: Model): string =>
  model.route._tag === "NotFound"
    ? "Not Found"
    : `Chat: ${model.chatPage.roomId}`;

const routeKey = (model: Model): string =>
  M.value(model.route).pipe(
    M.tagsExhaustive({
      NotFound: ({ path }) => `NotFound:${path}`,
      Chat: ({ roomId }) =>
        isUnknownRoom(model) ? `RoomNotFound:${roomId}` : `Chat:${roomId}`,
      Home: () => `Chat:${model.chatPage.roomId}`,
    }),
  );
