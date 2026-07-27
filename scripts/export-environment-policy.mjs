import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { environmentPolicyId } from "./environment-parity.mjs";

const [environment] = process.argv.slice(2);

try {
  if ((environment !== "staging" && environment !== "production") || process.argv.length !== 3) {
    throw new Error("Usage: export-environment-policy <staging|production>");
  }
  const githubEnvironmentPath = process.env["GITHUB_ENV"];
  if (githubEnvironmentPath === undefined) {
    throw new Error("GITHUB_ENV is missing");
  }
  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}`;
  const webOrigin = process.env[`${prefix}_WEB_ORIGIN`];
  if (webOrigin === undefined) {
    throw new Error(`${prefix}_WEB_ORIGIN is missing`);
  }
  const readJson = (relativePath) => JSON.parse(readFileSync(path.resolve(relativePath), "utf8"));
  const policyId = environmentPolicyId({
    environment,
    cors: readJson(`.wrangler/deploy/r2-cors-${environment}.json`),
    lifecycle: readJson(`.wrangler/deploy/r2-lifecycle-${environment}.json`),
    retention: {
      auditRetentionDays: process.env["AUDIT_RETENTION_DAYS"],
      multipartRetentionHours: process.env["MULTIPART_RETENTION_HOURS"],
      resultRetentionDays: process.env["RESULT_RETENTION_DAYS"],
      sourceRetentionDays: process.env["SOURCE_RETENTION_DAYS"],
    },
    runpodPlan: readJson(`.runpod/deploy/${environment}-plan.json`),
    webOrigin,
  });
  appendFileSync(
    githubEnvironmentPath,
    `ENVIRONMENT_POLICY_ID=${policyId}\nEXPECTED_ENVIRONMENT_POLICY_ID=${policyId}\n`,
    "utf8",
  );
  console.log(`Exported normalized ${environment} environment policy identity.`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to export environment policy identity",
  );
  process.exitCode = 1;
}
