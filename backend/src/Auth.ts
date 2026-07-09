import type { RuntimeContext } from "alchemy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import pg from "pg";

import { Account, Session, User, Verification } from "./auth-schema.ts";
import { UserId } from "./ChatProtocol.ts";
import { Hyperdrive } from "./Db.ts";

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

export type AuthUser = {
  readonly id: UserId;
  readonly name: string;
  readonly email: string;
};

type MakeAuthOptions = {
  secret: string;
  baseOrigin: string;
  frontendOrigin: Option.Option<string>;
  isLocal: boolean;
};

// Exactly one origin may make credentialed requests: the frontend bound as
// FRONTEND_ORIGIN in alchemy.run.ts (the deployed Website in cloud stages,
// http://localhost:1337 under `alchemy dev`). Nothing else — a wildcard
// would let any site ride the SameSite=None session cookie, and even a
// dev-localhost entry would let a local process hit production with it.
// Option.none means the binding is missing (a wiring bug): deny everything.
const makeIsAllowedOrigin =
  (frontendOrigin: Option.Option<string>) =>
  (origin: string): boolean =>
    Option.exists(frontendOrigin, (allowed) => allowed === origin);

const makeAuth = (pool: pg.Pool, options: MakeAuthOptions) => {
  const isAllowedOrigin = makeIsAllowedOrigin(options.frontendOrigin);
  return betterAuth({
    database: drizzleAdapter(drizzle({ client: pool }), {
      provider: "pg",
      schema: {
        user: User,
        session: Session,
        account: Account,
        verification: Verification,
      },
    }),
    secret: options.secret,
    baseURL: options.baseOrigin,
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
      // We can add something here for email verification (Cloudflare Email Routing
      // domain + `Cloudflare.Email.Send`); wire `sendVerificationEmail` in
      // `emailVerification` at the same time.
      requireEmailVerification: false,
    },
    session: {
      // Short-lived signed cookie holding the session payload, so gated
      // requests validate without a database round-trip until it expires.
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    // BetterAuth checks the Origin header of state-changing requests
    // against this list; echoing the (validated) request origin keeps it in
    // lockstep with the CORS policy in ChatService.
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      return origin != null && isAllowedOrigin(origin) ? [origin] : [];
    },
    // Prod: the frontend and this worker are different workers.dev sites,
    // so the session cookie must be `SameSite=None; Secure` to cross sites.
    // Dev: both origins are localhost (same-site), and Safari refuses
    // `Secure` cookies over plain http, so keep the defaults there.
    advanced: options.isLocal
      ? {}
      : {
          defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
          },
        },
    // OAuth extension point — add providers here later, e.g.
    // just a config change so should be easy
    // socialProviders: { github: { clientId, clientSecret } }.
  });
};

type AuthInstance = ReturnType<typeof makeAuth>;

export type BetterAuthApi = {
  /**
   * Whether `origin` may make credentialed requests against this worker.
   * Reads the worker environment when called, so only invoke it inside a
   * request handler (where the runtime env exists).
   */
  isAllowedOrigin: (origin: string) => boolean;
  withAuth: <A>(
    requestUrl: string,
    use: (auth: AuthInstance) => Promise<A>,
  ) => Effect.Effect<A, AuthError, RuntimeContext>;
  /** Resolve the session cookie on `request` to its user, if any. */
  sessionUser: (
    request: Request,
  ) => Effect.Effect<Option.Option<AuthUser>, AuthError, RuntimeContext>;
};

/**
 * Effect-native BetterAuth for workers. `withAuth` builds a per-invocation
 * BetterAuth instance over the shared Hyperdrive connection: pg sockets
 * cannot be reused across Worker invocations, so a fresh single-connection
 * pool is opened per request (cheap — Hyperdrive does the real pooling
 * server-side) and closed when the effect settles.
 */
export class BetterAuth extends Context.Service<BetterAuth, BetterAuthApi>()(
  "BetterAuth",
) {}

/**
 * Request-level helpers shared by every worker that gates routes on the
 * BetterAuth session. Build once per worker from the yielded `BetterAuth`
 * service.
 */
export const makeAuthGate = (auth: BetterAuthApi) => {
  // Resolve the caller's session from the request cookie. Runs on every
  // gated route; BetterAuth's cookie cache answers most lookups without
  // touching the database.
  const sessionUser: Effect.Effect<
    Option.Option<AuthUser>,
    AuthError,
    RuntimeContext | HttpServerRequest.HttpServerRequest
  > = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* auth.sessionUser(request.source as Request);
  });

  const unauthorized = HttpServerResponse.text("Unauthorized", {
    status: 401,
  });

  // The auth backend failing is a server-side outage, not a client
  // problem: log it and degrade to a 503 instead of crashing the handler.
  const authUnavailable = (error: AuthError) =>
    Effect.logError("Auth backend unavailable", error.cause).pipe(
      Effect.as(
        HttpServerResponse.text("Service unavailable", { status: 503 }),
      ),
    );

  // Credentialed CORS: the session cookie only flows cross-origin when the
  // specific origin is echoed back (a wildcard is invalid with
  // credentials); the allowlist is the deployed frontend.
  const cors = HttpMiddleware.cors({
    allowedOrigins: auth.isAllowedOrigin,
    credentials: true,
  });

  // BetterAuth owns everything under /api/auth/* (sign-up, sign-in,
  // sign-out, get-session, and OAuth callbacks later); mount this on that
  // route.
  const handleAuthApi = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const source = request.source as Request;
    const response = yield* auth.withAuth(source.url, (instance) =>
      instance.handler(source),
    );
    return HttpServerResponse.fromWeb(response);
  }).pipe(Effect.catchTag("AuthError", authUnavailable));

  return { sessionUser, unauthorized, authUnavailable, cors, handleAuthApi };
};

export const BetterAuthPg = Layer.effect(
  BetterAuth,
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const secretResource = yield* Alchemy.Random("BetterAuthSecret");
    // Registers a `secret_text` binding at deploy time and reads it back
    // from the worker environment at runtime.
    const secret = yield* Output.named(
      Output.asOutput(secretResource.text),
      "BETTER_AUTH_SECRET",
    );

    // FRONTEND_ORIGIN is a plain-text binding attached in alchemy.run.ts
    // (the Website's URL — it can't be bound from here without creating a
    // module cycle with ChatService). Read lazily: it only exists at
    // runtime, and this layer also builds at plan time. Empty means the
    // first deploy of a fresh stage ran before the Website URL existed.
    const frontendOrigin = (): Option.Option<string> => {
      const raw = env.FRONTEND_ORIGIN as string | undefined;
      return raw ? Option.some(new URL(raw).origin) : Option.none();
    };

    const withAuth = <A>(
      requestUrl: string,
      use: (auth: AuthInstance) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        const baseOrigin = new URL(requestUrl).origin;
        const connectionString = Redacted.value(yield* conn.connectionString);
        const secretValue = Redacted.value(yield* secret);
        const frontend = frontendOrigin();
        const pool = new pg.Pool({ connectionString, max: 1 });
        return yield* Effect.tryPromise({
          try: () =>
            use(
              makeAuth(pool, {
                secret: secretValue,
                baseOrigin,
                frontendOrigin: frontend,
                isLocal: /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(
                  baseOrigin,
                ),
              }),
            ),
          catch: (cause) => new AuthError({ cause }),
        }).pipe(
          Effect.ensuring(Effect.promise(() => pool.end()).pipe(Effect.ignore)),
        );
      });

    return {
      isAllowedOrigin: (origin: string) =>
        makeIsAllowedOrigin(frontendOrigin())(origin),
      withAuth,
      sessionUser: (request: Request) =>
        withAuth(request.url, (auth) =>
          auth.api.getSession({ headers: request.headers }),
        ).pipe(
          Effect.map((result) =>
            Option.map(
              Option.fromNullishOr(result),
              // BetterAuth just verified the session cookie, so this is the
              // authoritative place to mint the branded id.
              ({ user }): AuthUser => ({
                id: UserId.make(user.id),
                name: user.name,
                email: user.email,
              }),
            ),
          ),
        ),
    };
  }),
);
