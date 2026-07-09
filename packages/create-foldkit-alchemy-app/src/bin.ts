#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import packageJson from "../package.json" with { type: "json" };
import { command } from "./Cli.ts";

command.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
