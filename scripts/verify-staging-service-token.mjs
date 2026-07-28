import process from "node:process";

import { verifyStagingServiceToken } from "./access-verifier.mjs";

try {
  const results = await verifyStagingServiceToken(
    fetch,
    process.env.SCRIBE_DROP_STAGING_WEB_ORIGIN,
    process.env.SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN,
    process.env.SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME,
    {
      clientId: process.env.CF_ACCESS_CLIENT_ID,
      clientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
    },
  );
  for (const result of results) {
    console.log(`${result.path}: service-authenticated (${result.status})`);
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Staging Access service credential verification failed",
  );
  process.exitCode = 1;
}
