import path from "node:path";
import process from "node:process";

import { runCloudflareReadback } from "./cloudflare-readback.mjs";

const [environment] = process.argv.slice(2);

try {
  if ((environment !== "staging" && environment !== "production") || process.argv.length !== 3) {
    throw new Error("Usage: verify-cloudflare-readback <staging|production>");
  }
  const configName =
    environment === "staging" ? "orchestrator-staging.toml" : "orchestrator-production.toml";
  await runCloudflareReadback({
    configPath: path.resolve(".wrangler", "deploy", configName),
    corsPath: path.resolve(".wrangler", "deploy", `r2-cors-${environment}.json`),
    environment,
    d1DatabaseId: process.env[`SCRIBE_DROP_${environment.toUpperCase()}_D1_DATABASE_ID`],
    lifecyclePath: path.resolve(".wrangler", "deploy", `r2-lifecycle-${environment}.json`),
    pagesConfigPath: path.resolve(
      "apps",
      "web",
      ".wrangler",
      "deploy",
      environment === "staging" ? "wrangler.toml" : "wrangler-production.toml",
    ),
    runpodPlanPath: path.resolve(".runpod", "deploy", `${environment}-plan.json`),
  });
  console.log(`Verified Cloudflare ${environment} resource read-back.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloudflare resource read-back failed");
  process.exitCode = 1;
}
