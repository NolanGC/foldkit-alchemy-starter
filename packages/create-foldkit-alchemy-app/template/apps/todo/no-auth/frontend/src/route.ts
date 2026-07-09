import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { r } from "foldkit/route";

export const HomeRoute = r("Home");
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([HomeRoute, NotFoundRoute]);

export type HomeRoute = typeof HomeRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(HomeRoute));

const routeParser = Route.oneOf(homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
);
