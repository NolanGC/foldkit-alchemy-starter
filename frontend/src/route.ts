import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { literal, r, schemaSegment, slash } from "foldkit/route";

export const HomeRoute = r("Home");
export const RoomId = S.NonEmptyString;
export const ChatRoute = r("Chat", { roomId: RoomId });
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([HomeRoute, ChatRoute, NotFoundRoute]);

export type HomeRoute = typeof HomeRoute.Type;
export type ChatRoute = typeof ChatRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(HomeRoute));
export const chatRouter = pipe(
  literal("chat"),
  slash(schemaSegment("roomId", RoomId)),
  Route.mapTo(ChatRoute),
);

const routeParser = Route.oneOf(chatRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
);
