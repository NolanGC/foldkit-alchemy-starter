// Pure update-logic tests (Foldkit Story): messages in, model + commands
// out. No DOM, no network — commands are asserted and resolved by hand, so
// nothing here proves a fetch actually behaves as modeled.
//
// Covers:
// - init: cached session lands LoggedIn + fetches todos; the todos route
//   without a session redirects to login.
// - The fetched todo list is stored.
// - Adding: trims input, ignores empty submissions, appends the created
//   todo and clears the input when the request resolves.
// - Toggling and deleting a todo update the list from the server response.
// - A failed mutation surfaces an error that clears on the next edit.
//
// Does NOT cover:
// - Rendering (see scene.test.ts) or real command effects (HTTP).
// - The logged-out form flows: sign-in/sign-up input, pending, auth errors,
//   sign-out.
// - Navigation/URL-change messages after init.
import { TodoId, UserId, type Todo } from "@foldkit/backend";
import { DateTime, Option } from "effect";
import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import {
  ClickedDelete,
  ClickedToggle,
  CreateTodo,
  DeleteTodo,
  DeletedTodo,
  CreatedTodo,
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

const session = {
  userId: UserId.make("user-1"),
  email: "ada@example.com",
  name: "Ada",
};
const loggedInFlags = { maybeSession: Option.some(session) };
const loggedOutFlags = { maybeSession: Option.none<typeof session>() };

const asLoggedIn = (model: Model): Extract<Model, { _tag: "LoggedIn" }> => {
  if (model._tag !== "LoggedIn") {
    throw new Error(`Expected LoggedIn model, got ${model._tag}`);
  }
  return model;
};

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

const loadedModel = (
  todos: ReadonlyArray<Todo>,
): Extract<Model, { _tag: "LoggedIn" }> => {
  const [model] = init(loggedInFlags, url("/todos"));
  return { ...asLoggedIn(model), todos: TodosLoaded({ todos }) };
};

describe("update", () => {
  test("init with a cached session lands logged in and fetches todos", () => {
    const [model, commands] = init(loggedInFlags, url("/todos"));
    const loggedIn = asLoggedIn(model);

    expect(loggedIn.route._tag).toBe("Todos");
    expect(loggedIn.todos._tag).toBe("TodosLoading");
    // FetchTodos + the boot-time CheckSession revalidation.
    expect(commands).toHaveLength(2);
  });

  test("init without a session redirects the todos route to login", () => {
    const [model, commands] = init(loggedOutFlags, url("/todos"));

    expect(model._tag).toBe("LoggedOut");
    expect(model.route._tag).toBe("Login");
    // RedirectToLogin + CheckSession.
    expect(commands).toHaveLength(2);
  });

  test("the fetched todo list is stored", () => {
    const [model] = init(loggedInFlags, url("/todos"));
    const [next] = update(model, GotTodos({ todos: [milk, bread] }));

    expect(asLoggedIn(next).todos).toEqual(
      TodosLoaded({ todos: [milk, bread] }),
    );
  });

  test("submitting a new todo trims, creates, and clears the input", () => {
    Story.story(
      update,
      Story.with<Model>({ ...loadedModel([]), newTitle: "  Buy milk  " }),
      Story.message(SubmittedNewTodo()),
      Story.Command.expectExact(CreateTodo({ title: "Buy milk" })),
      Story.Command.resolve(CreateTodo, CreatedTodo({ todo: milk })),
      Story.model((model) => {
        const loggedIn = asLoggedIn(model);
        expect(loggedIn.todos).toEqual(TodosLoaded({ todos: [milk] }));
        expect(loggedIn.newTitle).toBe("");
        expect(loggedIn.creating).toBe(false);
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
        expect(asLoggedIn(model).todos).toEqual(
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
        expect(asLoggedIn(model).todos).toEqual(
          TodosLoaded({ todos: [bread] }),
        );
      }),
    );
  });

  test("a failed mutation surfaces an error that clears on the next edit", () => {
    Story.story(
      update,
      Story.with<Model>(loadedModel([milk])),
      Story.message(FailedMutateTodo({ error: "Failed to add the todo." })),
      Story.model((model) => {
        expect(asLoggedIn(model).actionError).toEqual(
          Option.some("Failed to add the todo."),
        );
      }),
      Story.message(UpdatedNewTitle({ value: "B" })),
      Story.model((model) => {
        expect(asLoggedIn(model).actionError).toEqual(Option.none());
      }),
    );
  });
});
