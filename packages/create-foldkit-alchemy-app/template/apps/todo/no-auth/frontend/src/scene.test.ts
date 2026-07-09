// View-rendering tests (Foldkit Scene): a model in, semantic queries
// (roles/labels/text) against the rendered view out. No real browser and no
// command execution.
//
// Covers:
// - The todo list renders its items, the labeled composer with Add disabled
//   when empty, per-item toggle/delete controls, and the remaining count.
// - The empty state and the loading state.
// - A mutation error renders as role="alert".
// - Unknown paths render "Page not found".
//
// Does NOT cover:
// - Click flows (adding, toggling, deleting).
// - Anything visual: layout, styling, focus management.
import { TodoId, type Todo } from "@foldkit/backend";
import { DateTime, Option } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { TodosLoaded, TodosLoading, update, view, type Model } from "./main";
import { HomeRoute, NotFoundRoute } from "./route";

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

const loadedModel: Model = {
  route: HomeRoute(),
  todos: TodosLoaded({ todos: [milk, bread] }),
  newTitle: "",
  creating: false,
  actionError: Option.none(),
};

describe("view", () => {
  test("the todo list renders items, controls, and the remaining count", () => {
    Scene.scene(
      { update, view },
      Scene.with(loadedModel),
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
      Scene.with({ ...loadedModel, todos: TodosLoaded({ todos: [] }) }),
      Scene.expect(Scene.text("Nothing to do yet.")).toExist(),
    );
  });

  test("loading renders no empty state", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loadedModel, todos: TodosLoading() }),
      Scene.expect(Scene.text("Loading todos…")).toExist(),
      Scene.expect(Scene.text("Nothing to do yet.")).not.toExist(),
    );
  });

  test("a mutation error renders as an alert", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...loadedModel,
        actionError: Option.some("Failed to add the todo."),
      }),
      Scene.expect(Scene.role("alert")).toExist(),
      Scene.expect(Scene.text("Failed to add the todo.")).toExist(),
    );
  });

  test("unknown paths render the not-found view", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loadedModel, route: NotFoundRoute({ path: "/nope" }) }),
      Scene.expect(Scene.role("heading", { name: "Page not found" })).toExist(),
    );
  });
});
