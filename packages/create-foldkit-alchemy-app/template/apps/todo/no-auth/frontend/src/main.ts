import { MAX_TODO_TITLE_LENGTH, Todo, TodoId } from "@foldkit/backend";
import { Input } from "@foldkit/ui";
import { Array, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, Runtime } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import { API_URL } from "./config";
import { AppRoute, homeRouter, urlToAppRoute } from "./route";

const APP_NAME = "__PROJECT_NAME__";

// MODEL

// Todos live in Postgres, so the client fetches them on boot and models
// them as remote data.
export const TodosLoading = ts("TodosLoading");
export const TodosFailed = ts("TodosFailed", { error: S.String });
export const TodosLoaded = ts("TodosLoaded", { todos: S.Array(Todo) });

const TodosState = S.Union([TodosLoading, TodosFailed, TodosLoaded]);
type TodosState = typeof TodosState.Type;

export const Model = S.Struct({
  route: AppRoute,
  todos: TodosState,
  newTitle: S.String,
  // True while a create request is in flight; the form is disabled so a
  // double submit can't insert twice.
  creating: S.Boolean,
  // Latest failed mutation (create/toggle/delete); cleared on the next edit.
  actionError: S.Option(S.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const CompletedNavigateInternal = m("CompletedNavigateInternal");
export const CompletedLoadExternal = m("CompletedLoadExternal");
export const ClickedLink = m("ClickedLink", {
  request: UrlRequest,
});
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const GotTodos = m("GotTodos", { todos: S.Array(Todo) });
export const FailedFetchTodos = m("FailedFetchTodos", { error: S.String });
export const UpdatedNewTitle = m("UpdatedNewTitle", { value: S.String });
export const SubmittedNewTodo = m("SubmittedNewTodo");
export const CreatedTodo = m("CreatedTodo", { todo: Todo });
export const ClickedToggle = m("ClickedToggle", {
  id: TodoId,
  completed: S.Boolean,
});
export const UpdatedTodo = m("UpdatedTodo", { todo: Todo });
export const ClickedDelete = m("ClickedDelete", { id: TodoId });
export const DeletedTodo = m("DeletedTodo", { id: TodoId });
export const FailedMutateTodo = m("FailedMutateTodo", { error: S.String });

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
  GotTodos,
  FailedFetchTodos,
  UpdatedNewTitle,
  SubmittedNewTodo,
  CreatedTodo,
  ClickedToggle,
  UpdatedTodo,
  ClickedDelete,
  DeletedTodo,
  FailedMutateTodo,
]);
export type Message = typeof Message.Type;

// FLAGS

export const Flags = S.Struct({});
export type Flags = typeof Flags.Type;

export const flags: Effect.Effect<Flags> = Effect.succeed(Flags.make({}));

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  _flags,
  url,
) => [
  Model.make({
    route: urlToAppRoute(url),
    todos: TodosLoading(),
    newTitle: "",
    creating: false,
    actionError: Option.none(),
  }),
  [FetchTodos()],
];

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

// Error responses are plain text, so the body doubles as the user-facing
// message.
const apiFetch = (path: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(new URL(path, API_URL), init);
    const text = await response.text();
    return { response, text };
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const errorMessage = (
  response: Response,
  text: string,
  fallback: string,
): string =>
  text.trim().length > 0 && !response.ok
    ? text.trim()
    : `${fallback} (${response.status})`;

const jsonInit = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const decodeTodos = S.decodeUnknownOption(S.Array(Todo));
const decodeTodo = S.decodeUnknownOption(Todo);

export const FetchTodos = Command.define(
  "FetchTodos",
  GotTodos,
  FailedFetchTodos,
)(
  apiFetch("/api/todos").pipe(
    Effect.map(({ response, text }) =>
      Option.match(response.ok ? decodeTodos(parseJson(text)) : Option.none(), {
        onNone: () =>
          FailedFetchTodos({
            error: errorMessage(response, text, "Failed to load todos."),
          }),
        onSome: (todos) => GotTodos({ todos }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedFetchTodos({ error: String(error) })),
    ),
  ),
);

export const CreateTodo = Command.define(
  "CreateTodo",
  { title: S.String },
  CreatedTodo,
  FailedMutateTodo,
)(({ title }) =>
  apiFetch("/api/todos", jsonInit("POST", { title })).pipe(
    Effect.map(({ response, text }) =>
      Option.match(response.ok ? decodeTodo(parseJson(text)) : Option.none(), {
        onNone: () =>
          FailedMutateTodo({
            error: errorMessage(response, text, "Failed to add the todo."),
          }),
        onSome: (todo) => CreatedTodo({ todo }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedMutateTodo({ error: String(error) })),
    ),
  ),
);

export const ToggleTodo = Command.define(
  "ToggleTodo",
  { id: TodoId, completed: S.Boolean },
  UpdatedTodo,
  FailedMutateTodo,
)(({ completed, id }) =>
  apiFetch(`/api/todos/${id}`, jsonInit("PATCH", { completed })).pipe(
    Effect.map(({ response, text }) =>
      Option.match(response.ok ? decodeTodo(parseJson(text)) : Option.none(), {
        onNone: () =>
          FailedMutateTodo({
            error: errorMessage(response, text, "Failed to update the todo."),
          }),
        onSome: (todo) => UpdatedTodo({ todo }),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedMutateTodo({ error: String(error) })),
    ),
  ),
);

export const DeleteTodo = Command.define(
  "DeleteTodo",
  { id: TodoId },
  DeletedTodo,
  FailedMutateTodo,
)(({ id }) =>
  apiFetch(`/api/todos/${id}`, { method: "DELETE" }).pipe(
    Effect.map(({ response, text }) =>
      response.ok
        ? DeletedTodo({ id })
        : FailedMutateTodo({
            error: errorMessage(response, text, "Failed to delete the todo."),
          }),
    ),
    Effect.catch((error) =>
      Effect.succeed(FailedMutateTodo({ error: String(error) })),
    ),
  ),
);

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

const replaceTodo = (state: TodosState, todo: Todo): TodosState =>
  state._tag === "TodosLoaded"
    ? TodosLoaded({
        todos: Array.map(state.todos, (existing) =>
          existing.id === todo.id ? todo : existing,
        ),
      })
    : state;

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

      ChangedUrl: ({ url }) => [
        evo(model, { route: () => urlToAppRoute(url) }),
        [],
      ],

      GotTodos: ({ todos }) => [
        evo(model, { todos: () => TodosLoaded({ todos }) }),
        [],
      ],

      FailedFetchTodos: ({ error }) => [
        evo(model, { todos: () => TodosFailed({ error }) }),
        [],
      ],

      UpdatedNewTitle: ({ value }) => [
        evo(model, {
          newTitle: () => value,
          actionError: () => Option.none(),
        }),
        [],
      ],

      SubmittedNewTodo: () => {
        if (model.creating) return [model, []];
        const title = model.newTitle.trim();
        if (title.length === 0) return [model, []];
        return [
          evo(model, {
            creating: () => true,
            actionError: () => Option.none(),
          }),
          [CreateTodo({ title })],
        ];
      },

      CreatedTodo: ({ todo }) => [
        evo(model, {
          todos: (todos) =>
            todos._tag === "TodosLoaded"
              ? TodosLoaded({ todos: [...todos.todos, todo] })
              : todos,
          newTitle: () => "",
          creating: () => false,
        }),
        [],
      ],

      ClickedToggle: ({ completed, id }) => [
        model,
        [ToggleTodo({ id, completed })],
      ],

      UpdatedTodo: ({ todo }) => [
        evo(model, { todos: (todos) => replaceTodo(todos, todo) }),
        [],
      ],

      ClickedDelete: ({ id }) => [model, [DeleteTodo({ id })]],

      DeletedTodo: ({ id }) => [
        evo(model, {
          todos: (todos) =>
            todos._tag === "TodosLoaded"
              ? TodosLoaded({
                  todos: Array.filter(todos.todos, (todo) => todo.id !== id),
                })
              : todos,
        }),
        [],
      ],

      FailedMutateTodo: ({ error }) => [
        evo(model, {
          creating: () => false,
          actionError: () => Option.some(error),
        }),
        [],
      ],
    }),
  );

// SUBSCRIPTIONS

// This app has no sockets or other live resources; exported (as nothing) so
// entry.ts and scripts/prerender.ts can drive every app the same way.
export const subscriptions = undefined;
export const managedResources = undefined;

// VIEW

const fieldClass =
  "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:border-neutral-400 focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50";

export const view = (model: Model): Document =>
  M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({
        title: APP_NAME,
        body: todosPageView(model),
      }),
      NotFound: ({ path }) => notFoundDocument(path),
    }),
  );

const notFoundDocument = (path: string): Document => {
  const h = html<Message>();

  return {
    title: "Not Found",
    body: h.div(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [notFoundView("Page not found", `No route for ${path}.`)],
    ),
  };
};

const todoItemView = (todo: Todo): Html => {
  const h = html<Message>();

  return h.keyed("li")(
    todo.id,
    [
      h.Class(
        "flex items-center gap-3 border border-neutral-800 bg-neutral-900 px-4 py-3",
      ),
    ],
    [
      h.input([
        h.Type("checkbox"),
        h.Checked(todo.completed),
        h.OnClick(ClickedToggle({ id: todo.id, completed: !todo.completed })),
        h.AriaLabel(
          todo.completed
            ? `Mark "${todo.title}" as not done`
            : `Mark "${todo.title}" as done`,
        ),
        h.Class("size-4 shrink-0 accent-neutral-400"),
      ]),
      h.span(
        [
          h.Class(
            todo.completed
              ? "min-w-0 flex-1 break-words text-neutral-500 line-through"
              : "min-w-0 flex-1 break-words",
          ),
        ],
        [todo.title],
      ),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ClickedDelete({ id: todo.id })),
          h.AriaLabel(`Delete "${todo.title}"`),
          h.Class(
            "shrink-0 border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200",
          ),
        ],
        ["Delete"],
      ),
    ],
  );
};

const todoListView = (model: Model): Html => {
  const h = html<Message>();

  return M.value(model.todos).pipe(
    M.withReturnType<Html>(),
    M.tagsExhaustive({
      TodosLoading: () =>
        h.p([h.Class("mt-8 text-neutral-500")], ["Loading todos…"]),
      TodosFailed: ({ error }) =>
        h.p([h.Class("mt-8 text-sm text-red-400"), h.Role("alert")], [error]),
      TodosLoaded: ({ todos }) => {
        if (todos.length === 0) {
          return h.p(
            [h.Class("mt-8 text-neutral-500")],
            ["Nothing to do yet."],
          );
        }
        const remaining = Array.filter(todos, (todo) => !todo.completed).length;
        return h.div(
          [h.Class("mt-8")],
          [
            h.ul(
              [h.Class("flex flex-col gap-2")],
              Array.map(todos, todoItemView),
            ),
            h.p(
              [h.Class("mt-4 text-sm text-neutral-500")],
              [
                remaining === 1
                  ? "1 todo remaining"
                  : `${remaining} todos remaining`,
              ],
            ),
          ],
        );
      },
    }),
  );
};

const todosPageView = (model: Model): Html => {
  const h = html<Message>();
  const canSubmit =
    !model.creating &&
    model.newTitle.trim().length > 0 &&
    model.newTitle.trim().length <= MAX_TODO_TITLE_LENGTH;

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-xl px-4 py-10")],
        [
          h.h1([h.Class("text-2xl font-bold")], [APP_NAME]),
          h.p(
            [h.Class("mt-2 text-neutral-400")],
            [
              "A simple todo list built end-to-end with Effect, using Foldkit and Alchemy.",
            ],
          ),
          h.form(
            [h.Class("mt-8 flex gap-2"), h.OnSubmit(SubmittedNewTodo())],
            [
              Input.view<Message>({
                id: "new-todo",
                value: model.newTitle,
                isDisabled: model.creating,
                onInput: (value) => UpdatedNewTitle({ value }),
                toView: (attributes) =>
                  h.div(
                    [h.Class("min-w-0 flex-1")],
                    [
                      h.label(
                        [...attributes.label, h.Class("sr-only")],
                        ["New todo"],
                      ),
                      h.input([
                        ...attributes.input,
                        h.Type("text"),
                        h.Placeholder("What needs doing?"),
                        h.Class(fieldClass),
                      ]),
                    ],
                  ),
              }),
              h.button(
                [
                  h.Type("submit"),
                  h.Disabled(!canSubmit),
                  h.Class(
                    "shrink-0 border border-neutral-700 bg-neutral-800 px-4 py-3 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
                  ),
                ],
                [model.creating ? "Adding…" : "Add"],
              ),
            ],
          ),
          Option.match(model.actionError, {
            onNone: () => h.empty,
            onSome: (error) =>
              h.p(
                [h.Class("mt-3 text-sm text-red-400"), h.Role("alert")],
                [error],
              ),
          }),
          todoListView(model),
        ],
      ),
    ],
  );
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
