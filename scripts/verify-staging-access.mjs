import process from "node:process";

import { verifyStagingAccess } from "./access-verifier.mjs";

try {
  const results = await verifyStagingAccess(
    fetch,
    process.env.SCRIBE_DROP_STAGING_WEB_ORIGIN,
    process.env.SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN,
  );
  for (const result of results) {
    console.log(`${result.path}: protected (${result.status})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging Access verification failed");
  process.exitCode = 1;
}
