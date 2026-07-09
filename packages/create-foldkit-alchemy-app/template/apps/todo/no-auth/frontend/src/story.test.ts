// Pure update-logic tests (Foldkit Story): messages in, model + commands
// out. No DOM, no network — commands are asserted and resolved by hand, so
// nothing here proves a fetch actually behaves as modeled.
//
// Covers:
// - init fetches the todo list; the fetched list is stored.
// - Adding: trims input, ignores empty submissions, appends the created
//   todo and clears the input when the request resolves.
// - Toggling and deleting a todo update the list from the server response.
// - A failed mutation surfaces an error that clears on the next edit.
//
// Does NOT cover:
// - Rendering (see scene.test.ts) or real command effects (HTTP).
// - Navigation/URL-change messages after init.
import { TodoId, type Todo } from "@foldkit/backend";
import { DateTime, Option } from "effect";
import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import {
  ClickedDelete,
  ClickedToggle,
  CreateTodo,
  CreatedTodo,
  DeleteTodo,
  DeletedTodo,
  FailedMutateTodo,
  GotTodos,
  SubmittedNewTodo,
  ToggleTodo,
  TodosLoaded,
  UpdatedNewTitle,
  UpdatedTodo,
  init,
  update,
  type Model,
} from "./main";

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

const url = (pathname: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

const loadedModel = (todos: ReadonlyArray<Todo>): Model => {
  const [model] = init({}, url("/"));
  return { ...model, todos: TodosLoaded({ todos }) };
};

describe("update", () => {
  test("init fetches the todo list", () => {
    const [model, commands] = init({}, url("/"));

    expect(model.route._tag).toBe("Home");
    expect(model.todos._tag).toBe("TodosLoading");
    expect(commands).toHaveLength(1);
  });

  test("the fetched todo list is stored", () => {
    const [model] = init({}, url("/"));
    const [next] = update(model, GotTodos({ todos: [milk, bread] }));

    expect(next.todos).toEqual(TodosLoaded({ todos: [milk, bread] }));
  });

  test("submitting a new todo trims, creates, and clears the input", () => {
    Story.story(
      update,
      Story.with<Model>({ ...loadedModel([]), newTitle: "  Buy milk  " }),
      Story.message(SubmittedNewTodo()),
      Story.Command.expectExact(CreateTodo({ title: "Buy milk" })),
      Story.Command.resolve(CreateTodo, CreatedTodo({ todo: milk })),
      Story.model((model) => {
        expect(model.todos).toEqual(TodosLoaded({ todos: [milk] }));
        expect(model.newTitle).toBe("");
        expect(model.creating).toBe(false);
      }),
    );
  });

  test("empty submissions are ignored", () => {
    Story.story(
      update,
      Story.with<Model>({ ...loadedModel([]), newTitle: "   " }),
      Story.message(SubmittedNewTodo()),
      Story.Command.expectNone(),
    );
  });

  test("toggling a todo applies the server's updated row", () => {
    Story.story(
      update,
      Story.with<Model>(loadedModel([milk])),
      Story.message(ClickedToggle({ id: milk.id, completed: true })),
      Story.Command.expectExact(ToggleTodo({ id: milk.id, completed: true })),
      Story.Command.resolve(
        ToggleTodo,
        UpdatedTodo({ todo: { ...milk, completed: true } }),
      ),
      Story.model((model) => {
        expect(model.todos).toEqual(
          TodosLoaded({ todos: [{ ...milk, completed: true }] }),
        );
      }),
    );
  });

  test("deleting a todo removes it from the list", () => {
    Story.story(
      update,
      Story.with<Model>(loadedModel([milk, bread])),
      Story.message(ClickedDelete({ id: milk.id })),
      Story.Command.expectExact(DeleteTodo({ id: milk.id })),
      Story.Command.resolve(DeleteTodo, DeletedTodo({ id: milk.id })),
      Story.model((model) => {
        expect(model.todos).toEqual(TodosLoaded({ todos: [bread] }));
      }),
    );
  });

  test("a failed mutation surfaces an error that clears on the next edit", () => {
    Story.story(
      update,
      Story.with<Model>(loadedModel([milk])),
      Story.message(FailedMutateTodo({ error: "Failed to add the todo." })),
      Story.model((model) => {
        expect(model.actionError).toEqual(
          Option.some("Failed to add the todo."),
        );
      }),
      Story.message(UpdatedNewTitle({ value: "B" })),
      Story.model((model) => {
        expect(model.actionError).toEqual(Option.none());
      }),
    );
  });
});
