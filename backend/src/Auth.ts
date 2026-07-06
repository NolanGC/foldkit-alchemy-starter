import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import pg from "pg";

import { Hyperdrive } from "./Db.ts";
import { Account, Session, User, Verification } from "./schema.ts";

export const FRONTEND_DEV_ORIGIN = "http://localhost:1337";

// Origins allowed to make credentialed requests against this worker. The
// prod frontend lives on its own workers.dev subdomain; binding the exact
// prod origin here would create a resource cycle (Website needs the chat
// URL, chat would need the Website URL), so we accept any workers.dev
// origin instead. Tighten this to the real origin once a custom domain
// exists.
export const isAllowedOrigin = (origin: string): boolean =>
  origin === FRONTEND_DEV_ORIGIN ||
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.workers\.dev$/.test(
    origin,
  );

export type AuthUser = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

type MakeAuthOptions = {
  connectionString: string;
  secret: string;
  baseOrigin: string;
  isLocal: boolean;
};

const makeAuth = (pool: pg.Pool, options: MakeAuthOptions) =>
  betterAuth({
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
      // Flip this on once an email sender exists (Cloudflare Email Routing
      // domain + `Cloudflare.Email.Send`); wire `sendVerificationEmail` in
      // `emailVerification` at the same time.
      requireEmailVerification: false,
    },
    // BetterAuth checks the Origin header of state-changing requests
    // against this list; echoing the (validated) request origin keeps it in
    // lockstep with the CORS policy above without hardcoding prod URLs.
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
    // socialProviders: { github: { clientId, clientSecret } }.
  });

type AuthInstance = ReturnType<typeof makeAuth>;

/**
 * Effect-native BetterAuth for workers. Yields a client whose `withAuth`
 * builds a per-invocation BetterAuth instance over the shared Hyperdrive
 * connection: pg sockets cannot be reused across Worker invocations, so a
 * fresh single-connection pool is opened per request (cheap — Hyperdrive
 * does the real pooling server-side) and closed when the effect settles.
 */
export const BetterAuth = Effect.gen(function* () {
  const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
  const secretResource = yield* Alchemy.Random("BetterAuthSecret");
  // Registers a `secret_text` binding at deploy time and reads it back from
  // the worker environment at runtime.
  const secret = yield* Output.named(
    Output.asOutput(secretResource.text),
    "BETTER_AUTH_SECRET",
  );

  const withAuth = <A>(
    requestUrl: string,
    use: (auth: AuthInstance) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      const baseOrigin = new URL(requestUrl).origin;
      const connectionString = Redacted.value(yield* conn.connectionString);
      const secretValue = Redacted.value(yield* secret);
      const pool = new pg.Pool({ connectionString, max: 1 });
      return yield* Effect.promise(() =>
        use(
          makeAuth(pool, {
            connectionString,
            secret: secretValue,
            baseOrigin,
            isLocal: /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(baseOrigin),
          }),
        ),
      ).pipe(
        Effect.ensuring(Effect.promise(() => pool.end()).pipe(Effect.ignore)),
      );
    });

  return {
    withAuth,
    /** Resolve the session cookie on `request` to its user, if any. */
    sessionUser: (request: Request) =>
      withAuth(request.url, (auth) =>
        auth.api.getSession({ headers: request.headers }),
      ).pipe(
        Effect.map((result) =>
          Option.map(
            Option.fromNullishOr(result),
            ({ user }): AuthUser => ({
              id: user.id,
              name: user.name,
              email: user.email,
            }),
          ),
        ),
      ),
  };
});
