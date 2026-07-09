import { Input } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import { FailedAuth, SignIn, SignUp, SucceededAuth } from "../auth";

// The BetterAuth sign-in / sign-up form as a page submodel: apps embed it
// with `h.submodel` + a wrapper message, and intercept `SucceededAuth` to
// perform their own logged-in transition. Everything else about the form —
// fields, pending state, error display, mode switching — lives here so every
// app shares one implementation.

// MODEL

export const SignInMode = ts("SignInMode");
export const SignUpMode = ts("SignUpMode");
export const AuthMode = S.Union([SignInMode, SignUpMode]);
export type AuthMode = typeof AuthMode.Type;

export const Model = S.Struct({
  mode: AuthMode,
  name: S.String,
  email: S.String,
  password: S.String,
  pending: S.Boolean,
  error: S.Option(S.String),
  // True while the boot-time `CheckSession` is still in flight and the
  // localStorage cache was empty — the form waits so a valid cookie doesn't
  // flash it before logging in. Driven by the parent (it owns the session
  // check) via `setCheckingSession`.
  checkingSession: S.Boolean,
});
export type Model = typeof Model.Type;

export const init = (checkingSession: boolean): Model => ({
  mode: SignInMode(),
  name: "",
  email: "",
  password: "",
  pending: false,
  error: Option.none(),
  checkingSession,
});

export const setCheckingSession = (
  model: Model,
  checkingSession: boolean,
): Model => evo(model, { checkingSession: () => checkingSession });

// MESSAGE

export const UpdatedName = m("UpdatedName", { value: S.String });
export const UpdatedEmail = m("UpdatedEmail", { value: S.String });
export const UpdatedPassword = m("UpdatedPassword", { value: S.String });
export const SwitchedMode = m("SwitchedMode", { mode: AuthMode });
export const Submitted = m("Submitted");

export const Message = S.Union([
  UpdatedName,
  UpdatedEmail,
  UpdatedPassword,
  SwitchedMode,
  Submitted,
  // Results of the SignIn/SignUp commands issued below. `SucceededAuth` is
  // handled by the parent (it swaps the whole model to logged-in), so it's
  // a no-op here.
  SucceededAuth,
  FailedAuth,
]);
export type Message = typeof Message.Type;

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      UpdatedName: ({ value }) => [evo(model, { name: () => value }), []],
      UpdatedEmail: ({ value }) => [evo(model, { email: () => value }), []],
      UpdatedPassword: ({ value }) => [
        evo(model, { password: () => value }),
        [],
      ],
      SwitchedMode: ({ mode }) => [
        evo(model, { mode: () => mode, error: () => Option.none() }),
        [],
      ],
      Submitted: () => {
        if (model.pending) return [model, []];
        const { mode, name, email, password } = model;
        return [
          evo(model, { pending: () => true, error: () => Option.none() }),
          [
            mode._tag === "SignInMode"
              ? SignIn({ email, password })
              : SignUp({ name, email, password }),
          ],
        ];
      },
      SucceededAuth: () => [model, []],
      FailedAuth: ({ error }) => [
        evo(model, {
          pending: () => false,
          error: () => Option.some(error),
        }),
        [],
      ],
    }),
  );

// VIEW

const fieldClass =
  "w-full border border-neutral-700 bg-neutral-950 px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:border-neutral-400 focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50";

export const view = Submodel.defineView<Model, Message>((model): Html => {
  const h = html<Message>();
  const isSignIn = model.mode._tag === "SignInMode";

  const field = (options: {
    id: string;
    label: string;
    type: string;
    value: string;
    onInput: (value: string) => Message;
    autocomplete: string;
  }): Html =>
    Input.view<Message>({
      id: options.id,
      value: options.value,
      isDisabled: model.pending || model.checkingSession,
      onInput: options.onInput,
      toView: (attributes) =>
        h.div(
          [h.Class("flex flex-col gap-1")],
          [
            h.label(
              [...attributes.label, h.Class("text-sm text-neutral-400")],
              [options.label],
            ),
            h.input([
              ...attributes.input,
              h.Type(options.type),
              h.Autocomplete(options.autocomplete),
              h.Class(fieldClass),
            ]),
          ],
        ),
    });

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 px-6 py-24 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-sm")],
        [
          h.h1(
            [h.Class("text-2xl font-bold")],
            [isSignIn ? "Sign in" : "Create an account"],
          ),
          h.form(
            [h.Class("mt-8 flex flex-col gap-4"), h.OnSubmit(Submitted())],
            [
              isSignIn
                ? h.empty
                : field({
                    id: "auth-name",
                    label: "Name",
                    type: "text",
                    value: model.name,
                    onInput: (value) => UpdatedName({ value }),
                    autocomplete: "name",
                  }),
              field({
                id: "auth-email",
                label: "Email",
                type: "email",
                value: model.email,
                onInput: (value) => UpdatedEmail({ value }),
                autocomplete: "email",
              }),
              field({
                id: "auth-password",
                label: "Password",
                type: "password",
                value: model.password,
                onInput: (value) => UpdatedPassword({ value }),
                autocomplete: isSignIn ? "current-password" : "new-password",
              }),
              Option.match(model.error, {
                onNone: () => h.empty,
                onSome: (error) =>
                  h.p(
                    [h.Class("text-sm text-red-400"), h.Role("alert")],
                    [error],
                  ),
              }),
              h.button(
                [
                  h.Type("submit"),
                  h.Disabled(model.pending || model.checkingSession),
                  h.Class(
                    "border border-neutral-700 bg-neutral-800 px-4 py-3 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
                  ),
                ],
                [
                  model.checkingSession
                    ? "Checking session…"
                    : model.pending
                      ? isSignIn
                        ? "Signing in…"
                        : "Signing up…"
                      : isSignIn
                        ? "Sign in"
                        : "Sign up",
                ],
              ),
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.OnClick(
                SwitchedMode({
                  mode: isSignIn ? SignUpMode() : SignInMode(),
                }),
              ),
              h.Class(
                "mt-6 text-sm text-neutral-400 underline underline-offset-4 hover:text-neutral-200",
              ),
            ],
            [
              isSignIn
                ? "No account? Sign up"
                : "Already have an account? Sign in",
            ],
          ),
        ],
      ),
    ],
  );
});
