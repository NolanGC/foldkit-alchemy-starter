import { Array, Cause, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, ManagedResource, Runtime, Subscription } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl, replaceUrl } from "foldkit/navigation";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import {
  CheckSession,
  ClearSession,
  CompletedSessionPersistence,
  CompletedSignOut,
  FailedCheckSession,
  GotSession,
  SaveSession,
  Session,
  SignOut,
  readStoredSession,
} from "./auth";
import { API_URL } from "./config";
import { Chat, Login } from "./page";
import {
  AppRoute,
  chatRouter,
  homeRouter,
  loginRouter,
  urlToAppRoute,
} from "./route";

const DEFAULT_ROOM_ID = "general";

// MODEL

// The set of valid rooms lives in Postgres, so the client fetches it after
// login and models it as remote data: nav tabs render from it, and chat
// routes for rooms outside it show "Room not found" instead of connecting.
export const RoomsLoading = ts("RoomsLoading");
export const RoomsFailed = ts("RoomsFailed", { error: S.String });
export const RoomsLoaded = ts("RoomsLoaded", {
  roomIds: S.Array(S.NonEmptyString),
});

const RoomsState = S.Union([RoomsLoading, RoomsFailed, RoomsLoaded]);
type RoomsState = typeof RoomsState.Type;

// Top-level union: chat state only exists when logged in. Both variants
// carry a `chatPage` because `Subscription.lift` needs a total projection;
// the LoggedOut copy stays disconnected so its subscriptions are inert.
// The sign-in/sign-up form itself is the shared `Login` page submodel.
export const LoggedOut = ts("LoggedOut", {
  route: AppRoute,
  loginPage: Login.Model,
  chatPage: Chat.Model,
});
export type LoggedOut = typeof LoggedOut.Type;

export const LoggedIn = ts("LoggedIn", {
  route: AppRoute,
  session: Session,
  rooms: RoomsState,
  chatPage: Chat.Model,
});
export type LoggedIn = typeof LoggedIn.Type;

export const Model = S.Union([LoggedOut, LoggedIn]);
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
export const GotLoginMessage = m("GotLoginMessage", {
  message: Login.Message,
});
export const ClickedSignOut = m("ClickedSignOut");

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
  GotRooms,
  FailedFetchRooms,
  GotChatMessage,
  GotLoginMessage,
  ClickedSignOut,
  GotSession,
  FailedCheckSession,
  CompletedSignOut,
  CompletedSessionPersistence,
]);
export type Message = typeof Message.Type;

// FLAGS

export const Flags = S.Struct({
  maybeSession: S.Option(Session),
});
export type Flags = typeof Flags.Type;

// The localStorage copy of the session gives an instant logged-in first
// paint; `CheckSession` then confirms against the cookie, which is the
// actual authority.
export const flags: Effect.Effect<Flags> = readStoredSession.pipe(
  Effect.map((maybeSession) => Flags.make({ maybeSession })),
);

// INIT

const routeRoomId = (route: AppRoute): string =>
  route._tag === "Chat" ? route.roomId : DEFAULT_ROOM_ID;

const initLoggedOut = (route: AppRoute, checkingSession: boolean): LoggedOut =>
  LoggedOut({
    route,
    loginPage: Login.init(checkingSession),
    chatPage: Chat.init(DEFAULT_ROOM_ID),
  });

const initLoggedIn = (route: AppRoute, session: Session): LoggedIn =>
  LoggedIn({
    route,
    session,
    rooms: RoomsLoading(),
    chatPage: Chat.init(routeRoomId(route)),
  });

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags,
  url,
) => {
  const route = urlToAppRoute(url);

  return Option.match(flags.maybeSession, {
    onNone: () =>
      route._tag === "Chat"
        ? ([
            initLoggedOut(LoginRouteValue, true),
            [RedirectToLogin(), CheckSession()],
          ] as const)
        : ([initLoggedOut(route, true), [CheckSession()]] as const),
    onSome: (session) =>
      route._tag === "Login"
        ? ([
            initLoggedIn(ChatRouteValue(DEFAULT_ROOM_ID), session),
            [RedirectToDefaultChat(), FetchRooms(), CheckSession()],
          ] as const)
        : ([
            initLoggedIn(route, session),
            [FetchRooms(), CheckSession()],
          ] as const),
  });
};

const LoginRouteValue: AppRoute = { _tag: "Login" };
const ChatRouteValue = (roomId: string): AppRoute => ({
  _tag: "Chat",
  roomId,
});
const HomeRouteValue: AppRoute = { _tag: "Home" };

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

const RedirectToLogin = Command.define(
  "RedirectToLogin",
  CompletedNavigateInternal,
)(replaceUrl(loginRouter()).pipe(Effect.as(CompletedNavigateInternal())));

const RedirectToDefaultChat = Command.define(
  "RedirectToDefaultChat",
  CompletedNavigateInternal,
)(
  replaceUrl(chatRouter({ roomId: DEFAULT_ROOM_ID })).pipe(
    Effect.as(CompletedNavigateInternal()),
  ),
);

const RedirectToHome = Command.define(
  "RedirectToHome",
  CompletedNavigateInternal,
)(replaceUrl(homeRouter()).pipe(Effect.as(CompletedNavigateInternal())));

const decodeRoomIds = S.decodeUnknownOption(S.Array(S.NonEmptyString));

const FetchRooms = Command.define(
  "FetchRooms",
  GotRooms,
  FailedFetchRooms,
)(
  Effect.tryPromise(async () => {
    const response = await fetch(new URL("/api/rooms", API_URL), {
      credentials: "include",
    });
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

// Entering the logged-in world from anywhere: land on the default room,
// persist the profile cache, and load the room list.
const enterLoggedIn = (session: Session): UpdateReturn => [
  initLoggedIn(ChatRouteValue(DEFAULT_ROOM_ID), session),
  [SaveSession({ session }), RedirectToDefaultChat(), FetchRooms()],
];

const leaveLoggedIn = (): UpdateReturn => [
  initLoggedOut(HomeRouteValue, false),
  [ClearSession(), RedirectToHome()],
];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      CompletedNavigateInternal: () => [model, []],
      CompletedLoadExternal: () => [model, []],
      CompletedSessionPersistence: () => [model, []],

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

        if (model._tag === "LoggedOut") {
          // Chat is gated; everything else is browsable while logged out.
          return route._tag === "Chat"
            ? [model, [RedirectToLogin()]]
            : [evo(model, { route: () => route }), []];
        }

        if (route._tag === "Login") {
          return [model, [RedirectToDefaultChat()]];
        }

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

      GotSession: ({ maybeSession }) =>
        M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (loggedOut) =>
              Option.match(maybeSession, {
                onNone: (): UpdateReturn => [
                  evo(loggedOut, {
                    loginPage: (loginPage) =>
                      Login.setCheckingSession(loginPage, false),
                  }),
                  [],
                ],
                onSome: (session) => enterLoggedIn(session),
              }),
            LoggedIn: (loggedIn) =>
              Option.match(maybeSession, {
                // The cookie is gone or expired: the cached profile lied.
                onNone: () => leaveLoggedIn(),
                onSome: (session): UpdateReturn => [
                  evo(loggedIn, { session: () => session }),
                  [SaveSession({ session })],
                ],
              }),
          }),
        ),

      // A network failure isn't evidence the session is invalid, so stay
      // put; gated requests will surface real 401s on their own.
      FailedCheckSession: () =>
        model._tag === "LoggedOut"
          ? [
              evo(model, {
                loginPage: (loginPage) =>
                  Login.setCheckingSession(loginPage, false),
              }),
              [],
            ]
          : [model, []],

      GotLoginMessage: ({ message }) => {
        // The submodel signals a completed sign-in/up; the transition out
        // of LoggedOut belongs to the app, so intercept it here.
        if (message._tag === "SucceededAuth") {
          return enterLoggedIn(message.session);
        }
        if (model._tag !== "LoggedOut") return [model, []];
        const [loginPage, commands] = Login.update(model.loginPage, message);
        return [
          evo(model, { loginPage: () => loginPage }),
          Command.mapMessages(commands, (message) =>
            GotLoginMessage({ message }),
          ),
        ];
      },

      ClickedSignOut: () => [model, [SignOut()]],
      CompletedSignOut: () => leaveLoggedIn(),

      GotRooms: ({ roomIds }) =>
        model._tag === "LoggedIn"
          ? [evo(model, { rooms: () => RoomsLoaded({ roomIds }) }), []]
          : [model, []],

      FailedFetchRooms: ({ error }) =>
        model._tag === "LoggedIn"
          ? [evo(model, { rooms: () => RoomsFailed({ error }) }), []]
          : [model, []],

      GotChatMessage: ({ message }) => {
        if (model._tag !== "LoggedIn") return [model, []];
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
const isUnknownRoom = (model: LoggedIn): boolean =>
  model.route._tag === "Chat" &&
  model.rooms._tag === "RoomsLoaded" &&
  !Array.contains(model.rooms.roomIds, model.route.roomId);

export const managedResources = ManagedResource.lift(Chat.managedResources)<
  Model,
  Message
>({
  toChildModel: (model) =>
    model._tag === "LoggedIn" &&
    model.route._tag === "Chat" &&
    !isUnknownRoom(model)
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

const navigationView = (model: LoggedIn): Html => {
  const h = html<Message>();

  const linkClassName = (isActive: boolean) =>
    `px-3 py-2 text-sm font-medium ${isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"}`;

  const roomIds = model.rooms._tag === "RoomsLoaded" ? model.rooms.roomIds : [];

  return h.nav(
    [h.Class("border-b border-neutral-900")],
    [
      h.div(
        [
          h.Class(
            "mx-auto flex max-w-5xl items-center gap-2 px-3 py-3 sm:px-4",
          ),
        ],
        [
          h.div(
            [
              h.Class(
                "mr-2 shrink-0 text-sm font-bold uppercase text-neutral-400 sm:mr-4",
              ),
            ],
            [h.a([h.Href(homeRouter())], ["Foldkit Chat"])],
          ),
          // Independently scrollable so the tab row never squishes the
          // brand or the sign-out control on narrow screens.
          h.ul(
            [
              h.Class(
                "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
              ),
            ],
            Array.map(roomIds, (roomId) =>
              h.li(
                [],
                [
                  h.a(
                    [
                      h.Href(chatRouter({ roomId })),
                      h.Class(linkClassName(isActiveRoom(model.route, roomId))),
                    ],
                    [`#${roomId}`],
                  ),
                ],
              ),
            ),
          ),
          h.div(
            [
              h.Class(
                "ml-2 flex shrink-0 items-center gap-2 sm:ml-auto sm:gap-3",
              ),
            ],
            [
              h.span(
                [h.Class("hidden text-sm text-neutral-400 sm:inline")],
                [model.session.name],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.OnClick(ClickedSignOut()),
                  h.Class(
                    "border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm font-medium text-neutral-300 hover:bg-neutral-800 sm:px-3",
                  ),
                ],
                ["Sign out"],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

export const view = (model: Model): Document =>
  model._tag === "LoggedOut" ? loggedOutView(model) : loggedInView(model);

const loggedOutView = (model: LoggedOut): Document => {
  const h = html<Message>();

  return M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({ title: "FoldkitChat", body: landingView(false) }),
      // Redirect in flight; render the landing rather than a flash of form.
      Chat: () => ({ title: "FoldkitChat", body: landingView(false) }),
      Login: () => ({
        title:
          model.loginPage.mode._tag === "SignInMode"
            ? "Sign in — FoldkitChat"
            : "Sign up — FoldkitChat",
        body: loginView(model),
      }),
      NotFound: ({ path }) => ({
        title: "Not Found",
        body: h.div(
          [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
          [notFoundView("Page not found", `No route for ${path}.`)],
        ),
      }),
    }),
  );
};

const loginView = (model: LoggedOut): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "login",
    model: model.loginPage,
    view: Login.view,
    toParentMessage: (message) => GotLoginMessage({ message }),
  });
};

const loggedInView = (model: LoggedIn): Document => {
  const h = html<Message>();

  if (model.route._tag === "Home") {
    return { title: "FoldkitChat", body: landingView(true) };
  }

  const routeContent = M.value(model.route).pipe(
    M.tagsExhaustive({
      NotFound: ({ path }) =>
        notFoundView("Page not found", `No route for ${path}.`),
      Login: () => h.empty,
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
        navigationView(model),
        h.keyed("main")(
          routeKey(model),
          [h.Class("min-h-0 flex-1 overflow-hidden")],
          [routeContent],
        ),
      ],
    ),
  };
};

const landingView = (isLoggedIn: boolean): Html => {
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
              h.Href(
                isLoggedIn
                  ? chatRouter({ roomId: DEFAULT_ROOM_ID })
                  : loginRouter(),
              ),
              h.Class("mt-8 inline-block underline underline-offset-4"),
            ],
            [isLoggedIn ? "Enter chat →" : "Sign in to chat →"],
          ),
        ],
      ),
    ],
  );
};

const chatView = (model: LoggedIn): Html => {
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

const routeTitle = (model: LoggedIn): string =>
  model.route._tag === "NotFound"
    ? "Not Found"
    : `Chat: ${model.chatPage.roomId}`;

const routeKey = (model: LoggedIn): string =>
  M.value(model.route).pipe(
    M.tagsExhaustive({
      NotFound: ({ path }) => `NotFound:${path}`,
      Login: () => "Login",
      Chat: ({ roomId }) =>
        isUnknownRoom(model) ? `RoomNotFound:${roomId}` : `Chat:${roomId}`,
      Home: () => `Chat:${model.chatPage.roomId}`,
    }),
  );
