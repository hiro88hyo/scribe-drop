import process from "node:process";

import { verifyCloudflareWorkerRoutePermission } from "./cloudflare-worker-route-permission.mjs";

const [environment] = process.argv.slice(2);

try {
  if ((environment !== "staging" && environment !== "production") || process.argv.length !== 3) {
    throw new Error("Usage: verify-cloudflare-worker-route-permission <staging|production>");
  }
  await verifyCloudflareWorkerRoutePermission({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    orchestratorOrigin: process.env[`SCRIBE_DROP_${environment.toUpperCase()}_ORCHESTRATOR_ORIGIN`],
  });
  console.log(`Verified Cloudflare ${environment} Worker route read capability.`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Cloudflare Worker route capability check failed",
  );
  process.exitCode = 1;
}
