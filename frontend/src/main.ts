import { Array, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, ManagedResource, Runtime, Subscription } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { Chat } from "./page";
import { AppRoute, chatRouter, homeRouter, urlToAppRoute } from "./route";

const DEFAULT_ROOM_ID = "general";
const ROOM_IDS = ["general", "random"];

// MODEL

export const Model = S.Struct({
  route: AppRoute,
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
export const GotChatMessage = m("GotChatMessage", {
  message: Chat.Message,
});

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
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
      chatPage: Chat.init(routeRoomId(route)),
    },
    [],
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
              route._tag === "NotFound"
                ? chatPage
                : Chat.connect(chatPage, routeRoomId(route)),
          }),
          [],
        ];
      },

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

export const managedResources = ManagedResource.lift(Chat.managedResources)<
  Model,
  Message
>({
  toChildModel: (model) =>
    model.route._tag === "NotFound"
      ? Option.none()
      : Option.some(model.chatPage),
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
  M.value(route).pipe(
    M.tag("Home", () => roomId === DEFAULT_ROOM_ID),
    M.tag("Chat", (chatRoute) => chatRoute.roomId === roomId),
    M.tag("NotFound", () => false),
    M.exhaustive,
  );

const navigationView = (currentRoute: AppRoute): Html => {
  const h = html<Message>();

  const linkClassName = (isActive: boolean) =>
    `px-3 py-2 text-sm font-medium ${isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;

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
          ...Array.map(ROOM_IDS, (roomId) =>
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

  const routeContent =
    model.route._tag === "NotFound"
      ? notFoundView(model.route.path)
      : chatView(model);

  return {
    title: routeTitle(model),
    body: h.div(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [
        navigationView(model.route),
        h.keyed("main")(routeKey(model), [], [routeContent]),
      ],
    ),
  };
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

const notFoundView = (path: string): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.div(
        [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
        [
          h.h1([h.Class("text-2xl font-bold")], ["Page not found"]),
          h.p([h.Class("mt-2 text-neutral-400")], [`No route for ${path}.`]),
          h.a(
            [
              h.Href(homeRouter()),
              h.Class(
                "mt-4 inline-block border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
              ),
            ],
            ["Back to chat"],
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
  model.route._tag === "NotFound"
    ? `NotFound:${model.route.path}`
    : `Chat:${model.chatPage.roomId}`;
