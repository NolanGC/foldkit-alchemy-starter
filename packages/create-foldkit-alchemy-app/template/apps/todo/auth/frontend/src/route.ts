import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { literal, r } from "foldkit/route";

export const HomeRoute = r("Home");
export const LoginRoute = r("Login");
export const TodosRoute = r("Todos");
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([
  HomeRoute,
  LoginRoute,
  TodosRoute,
  NotFoundRoute,
]);

export type HomeRoute = typeof HomeRoute.Type;
export type LoginRoute = typeof LoginRoute.Type;
export type TodosRoute = typeof TodosRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(HomeRoute));
export const loginRouter = pipe(literal("login"), Route.mapTo(LoginRoute));
export const todosRouter = pipe(literal("todos"), Route.mapTo(TodosRoute));

const routeParser = Route.oneOf(todosRouter, loginRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
);
