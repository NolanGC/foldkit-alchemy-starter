import { MAX_TODO_TITLE_LENGTH, Todo, TodoId } from "@foldkit/backend";
import { Input } from "@foldkit/ui";
import { Array, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, Runtime } from "foldkit";
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
import { Login } from "./page";
import {
  AppRoute,
  homeRouter,
  loginRouter,
  todosRouter,
  urlToAppRoute,
} from "./route";

const APP_NAME = "__PROJECT_NAME__";

// MODEL

// Todos live in Postgres, so the client fetches them after login and models
// them as remote data.
export const TodosLoading = ts("TodosLoading");
export const TodosFailed = ts("TodosFailed", { error: S.String });
export const TodosLoaded = ts("TodosLoaded", { todos: S.Array(Todo) });

const TodosState = S.Union([TodosLoading, TodosFailed, TodosLoaded]);
type TodosState = typeof TodosState.Type;

// Top-level union: todo state only exists when logged in. The
// sign-in/sign-up form itself is the shared `Login` page submodel.
export const LoggedOut = ts("LoggedOut", {
  route: AppRoute,
  loginPage: Login.Model,
});
export type LoggedOut = typeof LoggedOut.Type;

export const LoggedIn = ts("LoggedIn", {
  route: AppRoute,
  session: Session,
  todos: TodosState,
  newTitle: S.String,
  // True while a create request is in flight; the form is disabled so a
  // double submit can't insert twice.
  creating: S.Boolean,
  // Latest failed mutation (create/toggle/delete); cleared on the next edit.
  actionError: S.Option(S.String),
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
export const GotLoginMessage = m("GotLoginMessage", {
  message: Login.Message,
});
export const ClickedSignOut = m("ClickedSignOut");

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

const initLoggedOut = (route: AppRoute, checkingSession: boolean): LoggedOut =>
  LoggedOut({
    route,
    loginPage: Login.init(checkingSession),
  });

const initLoggedIn = (route: AppRoute, session: Session): LoggedIn =>
  LoggedIn({
    route,
    session,
    todos: TodosLoading(),
    newTitle: "",
    creating: false,
    actionError: Option.none(),
  });

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags,
  url,
) => {
  const route = urlToAppRoute(url);

  return Option.match(flags.maybeSession, {
    onNone: () =>
      route._tag === "Todos"
        ? ([
            initLoggedOut(LoginRouteValue, true),
            [RedirectToLogin(), CheckSession()],
          ] as const)
        : ([initLoggedOut(route, true), [CheckSession()]] as const),
    onSome: (session) =>
      route._tag === "Login"
        ? ([
            initLoggedIn(TodosRouteValue, session),
            [RedirectToTodos(), FetchTodos(), CheckSession()],
          ] as const)
        : ([
            initLoggedIn(route, session),
            [FetchTodos(), CheckSession()],
          ] as const),
  });
};

const LoginRouteValue: AppRoute = { _tag: "Login" };
const TodosRouteValue: AppRoute = { _tag: "Todos" };
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

const RedirectToTodos = Command.define(
  "RedirectToTodos",
  CompletedNavigateInternal,
)(replaceUrl(todosRouter()).pipe(Effect.as(CompletedNavigateInternal())));

const RedirectToHome = Command.define(
  "RedirectToHome",
  CompletedNavigateInternal,
)(replaceUrl(homeRouter()).pipe(Effect.as(CompletedNavigateInternal())));

// All API endpoints are cookie-authenticated, so every call must be
// credentialed — that's what makes the browser attach the session cookie
// across the frontend/api origin split. Error responses are plain text, so
// the body doubles as the user-facing message.
const apiFetch = (path: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(new URL(path, API_URL), {
      credentials: "include",
      ...init,
    });
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

// Entering the logged-in world from anywhere: land on the todo list,
// persist the profile cache, and load it.
const enterLoggedIn = (session: Session): UpdateReturn => [
  initLoggedIn(TodosRouteValue, session),
  [SaveSession({ session }), RedirectToTodos(), FetchTodos()],
];

const leaveLoggedIn = (): UpdateReturn => [
  initLoggedOut(HomeRouteValue, false),
  [ClearSession(), RedirectToHome()],
];

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
          // The todo list is gated; everything else is browsable while
          // logged out.
          return route._tag === "Todos"
            ? [model, [RedirectToLogin()]]
            : [evo(model, { route: () => route }), []];
        }

        if (route._tag === "Login") {
          return [model, [RedirectToTodos()]];
        }

        return [evo(model, { route: () => route }), []];
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

      GotTodos: ({ todos }) =>
        model._tag === "LoggedIn"
          ? [evo(model, { todos: () => TodosLoaded({ todos }) }), []]
          : [model, []],

      FailedFetchTodos: ({ error }) =>
        model._tag === "LoggedIn"
          ? [evo(model, { todos: () => TodosFailed({ error }) }), []]
          : [model, []],

      UpdatedNewTitle: ({ value }) =>
        model._tag === "LoggedIn"
          ? [
              evo(model, {
                newTitle: () => value,
                actionError: () => Option.none(),
              }),
              [],
            ]
          : [model, []],

      SubmittedNewTodo: () => {
        if (model._tag !== "LoggedIn" || model.creating) return [model, []];
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

      CreatedTodo: ({ todo }) =>
        model._tag === "LoggedIn"
          ? [
              evo(model, {
                todos: (todos) =>
                  todos._tag === "TodosLoaded"
                    ? TodosLoaded({ todos: [...todos.todos, todo] })
                    : todos,
                newTitle: () => "",
                creating: () => false,
              }),
              [],
            ]
          : [model, []],

      ClickedToggle: ({ completed, id }) =>
        model._tag === "LoggedIn"
          ? [model, [ToggleTodo({ id, completed })]]
          : [model, []],

      UpdatedTodo: ({ todo }) =>
        model._tag === "LoggedIn"
          ? [evo(model, { todos: (todos) => replaceTodo(todos, todo) }), []]
          : [model, []],

      ClickedDelete: ({ id }) =>
        model._tag === "LoggedIn" ? [model, [DeleteTodo({ id })]] : [model, []],

      DeletedTodo: ({ id }) =>
        model._tag === "LoggedIn"
          ? [
              evo(model, {
                todos: (todos) =>
                  todos._tag === "TodosLoaded"
                    ? TodosLoaded({
                        todos: Array.filter(
                          todos.todos,
                          (todo) => todo.id !== id,
                        ),
                      })
                    : todos,
              }),
              [],
            ]
          : [model, []],

      FailedMutateTodo: ({ error }) =>
        model._tag === "LoggedIn"
          ? [
              evo(model, {
                creating: () => false,
                actionError: () => Option.some(error),
              }),
              [],
            ]
          : [model, []],
    }),
  );

// SUBSCRIPTIONS

// This app has no sockets or other live resources; exported (as nothing) so
// entry.ts and scripts/prerender.ts can drive every app the same way.
export const subscriptions = undefined;
export const managedResources = undefined;

// VIEW

const navigationView = (model: LoggedIn): Html => {
  const h = html<Message>();

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
            [h.a([h.Href(homeRouter())], [APP_NAME])],
          ),
          h.ul(
            [h.Class("flex min-w-0 flex-1 items-center gap-1")],
            [
              h.li(
                [],
                [
                  h.a(
                    [
                      h.Href(todosRouter()),
                      h.Class(
                        `px-3 py-2 text-sm font-medium ${
                          model.route._tag === "Todos"
                            ? "bg-neutral-800 text-neutral-100"
                            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                        }`,
                      ),
                    ],
                    ["Todos"],
                  ),
                ],
              ),
            ],
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
      Home: () => ({ title: APP_NAME, body: landingView(false) }),
      // Redirect in flight; render the landing rather than a flash of form.
      Todos: () => ({ title: APP_NAME, body: landingView(false) }),
      Login: () => ({
        title:
          model.loginPage.mode._tag === "SignInMode"
            ? `Sign in — ${APP_NAME}`
            : `Sign up — ${APP_NAME}`,
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

const authFieldClass =
  "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:border-neutral-400 focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50";

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
    return { title: APP_NAME, body: landingView(true) };
  }

  const routeContent = M.value(model.route).pipe(
    M.tagsExhaustive({
      NotFound: ({ path }) =>
        notFoundView("Page not found", `No route for ${path}.`),
      Login: () => h.empty,
      Todos: () => todosView(model),
    }),
  );

  return {
    title:
      model.route._tag === "NotFound" ? "Not Found" : `Todos — ${APP_NAME}`,
    body: h.div(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [navigationView(model), routeContent],
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
          h.h1([h.Class("text-3xl font-bold")], [APP_NAME]),
          h.p(
            [h.Class("mt-3 text-neutral-400")],
            [
              "A simple todo list built end-to-end with Effect, using Foldkit and Alchemy.",
            ],
          ),
          h.a(
            [
              h.Href(isLoggedIn ? todosRouter() : loginRouter()),
              h.Class("mt-8 inline-block underline underline-offset-4"),
            ],
            [isLoggedIn ? "Open your todos →" : "Sign in to your todos →"],
          ),
        ],
      ),
    ],
  );
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

const todoListView = (model: LoggedIn): Html => {
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

const todosView = (model: LoggedIn): Html => {
  const h = html<Message>();
  const canSubmit =
    !model.creating &&
    model.newTitle.trim().length > 0 &&
    model.newTitle.trim().length <= MAX_TODO_TITLE_LENGTH;

  return h.main(
    [h.Class("mx-auto max-w-xl px-4 py-10")],
    [
      h.h1([h.Class("text-2xl font-bold")], ["Todos"]),
      h.form(
        [h.Class("mt-6 flex gap-2"), h.OnSubmit(SubmittedNewTodo())],
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
                    h.Class(authFieldClass),
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
          h.p([h.Class("mt-3 text-sm text-red-400"), h.Role("alert")], [error]),
      }),
      todoListView(model),
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
