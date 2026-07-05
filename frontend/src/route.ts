import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { literal, r, schemaSegment, slash } from "foldkit/route";

export const PostsRoute = r("Posts");
export const RoomId = S.NonEmptyString;
export const ChatRoute = r("Chat", { roomId: RoomId });
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([PostsRoute, ChatRoute, NotFoundRoute]);

export type PostsRoute = typeof PostsRoute.Type;
export type ChatRoute = typeof ChatRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const postsRouter = pipe(Route.root, Route.mapTo(PostsRoute));
export const chatRouter = pipe(
  literal("chat"),
  slash(schemaSegment("roomId", RoomId)),
  Route.mapTo(ChatRoute),
);

const routeParser = Route.oneOf(chatRouter, postsRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
);
