// View-rendering tests (Foldkit Scene): a model in, semantic queries
// (roles/labels/text) against the rendered view out. No real browser and no
// command execution.
//
// Covers:
// - Logged out: the login route renders the sign-in form; the landing page
//   links to sign-in.
// - Logged in: nav shows the user's name and a sign-out button; the todo
//   list renders its items, the labeled composer with Add disabled when
//   empty, per-item toggle/delete controls, the remaining count; the empty
//   state; a mutation error renders as role="alert".
//
// Does NOT cover:
// - Click flows (adding, toggling, deleting, signing out).
// - Anything visual: layout, styling, focus management.
import { TodoId, UserId, type Todo } from "@foldkit/backend";
import { DateTime, Option } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { TodosLoaded, update, view, type Model } from "./main";
import { Login } from "./page";
import { HomeRoute, LoginRoute, TodosRoute } from "./route";

const createdAt = DateTime.makeUnsafe(0);

const milk: Todo = {
  id: TodoId.make("00000000-0000-4000-8000-000000000001"),
  title: "Buy milk",
  completed: false,
  createdAt,
};

const bread: Todo = {
  id: TodoId.make("00000000-0000-4000-8000-000000000002"),
  title: "Bake bread",
  completed: true,
  createdAt,
};

const loggedInModel: Model = {
  _tag: "LoggedIn",
  route: TodosRoute(),
  session: {
    userId: UserId.make("user-ada"),
    email: "ada@example.com",
    name: "Ada",
  },
  todos: TodosLoaded({ todos: [milk, bread] }),
  newTitle: "",
  creating: false,
  actionError: Option.none(),
};

const loggedOutModel: Model = {
  _tag: "LoggedOut",
  route: LoginRoute(),
  loginPage: Login.init(false),
};

describe("view", () => {
  test("logged out, the login route renders the sign-in form", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedOutModel),
      Scene.expect(Scene.role("heading", { name: "Sign in" })).toExist(),
      Scene.expect(Scene.label("Email")).toExist(),
      Scene.expect(Scene.label("Password")).toExist(),
      Scene.expect(Scene.role("button", { name: "Sign in" })).toBeEnabled(),
    );
  });

  test("logged out, the landing page links to sign in", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loggedOutModel, route: HomeRoute() }),
      Scene.expect(
        Scene.role("link", { name: "Sign in to your todos →" }),
      ).toExist(),
    );
  });

  test("logged in, the nav shows the user and a sign out button", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedInModel),
      Scene.expect(Scene.text("Ada")).toExist(),
      Scene.expect(Scene.role("button", { name: "Sign out" })).toExist(),
    );
  });

  test("the todo list renders items, controls, and the remaining count", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedInModel),
      Scene.expect(Scene.role("heading", { name: "Todos" })).toExist(),
      Scene.expect(Scene.text("Buy milk")).toExist(),
      Scene.expect(Scene.text("Bake bread")).toExist(),
      Scene.expect(Scene.label("New todo")).toExist(),
      Scene.expect(Scene.role("button", { name: "Add" })).toBeDisabled(),
      Scene.expect(
        Scene.role("checkbox", { name: 'Mark "Buy milk" as done' }),
      ).toExist(),
      Scene.expect(
        Scene.role("button", { name: 'Delete "Buy milk"' }),
      ).toExist(),
      Scene.expect(Scene.text("1 todo remaining")).toExist(),
    );
  });

  test("an empty list renders the empty state", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loggedInModel, todos: TodosLoaded({ todos: [] }) }),
      Scene.expect(Scene.text("Nothing to do yet.")).toExist(),
    );
  });

  test("a mutation error renders as an alert", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...loggedInModel,
        actionError: Option.some("Failed to add the todo."),
      }),
      Scene.expect(Scene.role("alert")).toExist(),
      Scene.expect(Scene.text("Failed to add the todo.")).toExist(),
    );
  });
});
