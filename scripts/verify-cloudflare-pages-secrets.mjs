import { spawnSync } from "node:child_process";
import process from "node:process";

import { verifyRequiredPagesSecrets } from "./cloudflare-pages-secret-verifier.mjs";

const projectName = process.env.SCRIBE_DROP_PAGES_PROJECT ?? "scribe-drop-web-staging";
if (!/^[a-z0-9-]+$/u.test(projectName)) {
  throw new Error("SCRIBE_DROP_PAGES_PROJECT is invalid");
}

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

try {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Wrangler could not list encrypted Pages secret names");
  }
  const verification = verifyRequiredPagesSecrets(result.stdout);
  console.log(`Verified required encrypted Pages secrets: ${verification.requiredCount}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to verify required Pages secrets");
  process.exitCode = 1;
}
