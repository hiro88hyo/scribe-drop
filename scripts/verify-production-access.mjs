import process from "node:process";

import { verifyProductionAccess } from "./access-verifier.mjs";

try {
  const results = await verifyProductionAccess(
    fetch,
    process.env.SCRIBE_DROP_PRODUCTION_WEB_ORIGIN,
    process.env.SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN,
  );
  for (const result of results) {
    console.log(`${result.path}: protected (${result.status})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production Access verification failed");
  process.exitCode = 1;
}
