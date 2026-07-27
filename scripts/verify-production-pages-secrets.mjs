import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  requirePagesProjectName,
  verifyRequiredPagesSecrets,
} from "./cloudflare-pages-secret-verifier.mjs";

try {
  if (process.argv.length !== 2) {
    throw new Error("Production Pages secret verification takes no arguments");
  }
  const projectName = requirePagesProjectName("production");
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "pages", "secret", "list", "--project-name", projectName],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "0",
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Wrangler could not list encrypted production Pages secret names");
  }
  const verification = verifyRequiredPagesSecrets(result.stdout);
  console.log(
    `Verified required encrypted production Pages secrets: ${verification.requiredCount}`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to verify production Pages secrets",
  );
  process.exitCode = 1;
}
