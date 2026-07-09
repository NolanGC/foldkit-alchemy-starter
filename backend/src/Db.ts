import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Provider-agnostic Postgres service. Anything that needs a database
 * depends on this tag — never on Neon or PlanetScale directly. Swap
 * providers via the `PostgresLive` export below.
 */
export class Postgres extends Context.Service<
  Postgres,
  {
    /** Connection origin ready to feed into Cloudflare Hyperdrive. */
    readonly origin: Alchemy.Output<Cloudflare.Hyperdrive.Origin>;
    /** Provider-specific branch identifier, surfaced in stack outputs. */
    readonly branchId: Alchemy.Output<string>;
  }
>()("app/Postgres") {}

const Schema = Drizzle.Schema("app-schema", {
  schema: "./backend/src/schema.ts",
  out: "./migrations",
});

export const NeonPostgresLive = Layer.effect(
  Postgres,
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const schema = yield* Schema;

    const project = stage.startsWith("pr-")
      ? yield* Neon.Project.ref("app-db", { stage: "staging" })
      : yield* Neon.Project("app-db", {
          region: "aws-us-east-1",
        });

    const branch = yield* Neon.Branch("app-branch", {
      project,
      migrationsDir: schema.out,
    });

    return { origin: branch.origin, branchId: branch.branchId };
  }),
);

export const PlanetscalePostgresLive = Layer.effect(
  Postgres,
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const schema = yield* Schema;

    const database = stage.startsWith("pr-")
      ? yield* Planetscale.PostgresDatabase.ref("app-db", {
          stage: "staging",
        })
      : yield* Planetscale.PostgresDatabase("app-db", {
          region: { slug: "us-east" },
          clusterSize: "PS_10",
        });

    const branch = yield* Planetscale.PostgresBranch("app-branch", {
      database,
      migrationsDir: schema.out,
    });

    const role = yield* Planetscale.PostgresRole("app-role", {
      database,
      branch,
      inheritedRoles: ["postgres"],
    });

    return { origin: role.origin, branchId: branch.name };
  }),
);

/**
 * The active database provider — swap between `NeonPostgresLive` and
 * `PlanetscalePostgresLive` here; nothing else changes.
 */
export const PostgresLive = NeonPostgresLive;

export const Hyperdrive = Effect.gen(function* () {
  const { origin } = yield* Postgres;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin,
  });
}).pipe(Effect.provide(PostgresLive));
