import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { verifyStagingDispatchUniqueness } from "./staging-dispatch-uniqueness.mjs";

const [inventoryPath] = process.argv.slice(2);
if (inventoryPath === undefined || process.argv.length !== 3) {
  throw new Error("Usage: verify-staging-dispatch-uniqueness <workflow-runs-json>");
}

try {
  console.log(
    JSON.stringify(
      verifyStagingDispatchUniqueness(
        JSON.parse(readFileSync(path.resolve(inventoryPath), "utf8")),
        {
          commit: process.env.GITHUB_SHA,
          currentRunId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        },
      ),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging dispatch verification failed");
  process.exitCode = 1;
}
