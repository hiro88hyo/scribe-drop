import path from "node:path";
import process from "node:process";

import { validatePagesFunctionsModule } from "./release-candidate.mjs";

try {
  if (process.argv.length !== 2) {
    throw new Error("Pages Functions build verification does not accept arguments");
  }
  validatePagesFunctionsModule(
    path.resolve("apps", "web", ".wrangler", "functions-build", "index.js"),
  );
  console.log("Verified authenticated Pages Functions build routes.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Pages Functions build verification failed",
  );
  process.exitCode = 1;
}
