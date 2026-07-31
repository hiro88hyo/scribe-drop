import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  requirePagesProjectName,
  verifyRequiredPagesSecrets,
} from "./cloudflare-pages-secret-verifier.mjs";

try {
  const projectName = requirePagesProjectName("staging", process.env.SCRIBE_DROP_PAGES_PROJECT);
  const apiToken = process.env.CLOUDFLARE_PAGES_API_TOKEN;
  if (typeof apiToken !== "string" || !/^[A-Za-z0-9_-]{20,256}$/u.test(apiToken)) {
    throw new Error("Staging Pages API token is missing or invalid");
  }
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "pages", "secret", "list", "--project-name", projectName],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: apiToken,
        WRANGLER_WRITE_LOGS: "0",
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Wrangler could not list encrypted Pages secret names");
  }
  const verification = verifyRequiredPagesSecrets(result.stdout);
  console.log(`Verified required encrypted Pages secrets: ${verification.requiredCount}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to verify required Pages secrets");
  process.exitCode = 1;
}
