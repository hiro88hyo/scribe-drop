import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/u;
const runPattern = /^[1-9][0-9]*$/u;

export function validateProductionCutoverEvidence(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "commitSha,cutoverRunId,environment,operation,schemaVersion,smokeAuthorization,stagingRunId" ||
    value.schemaVersion !== 1 ||
    value.environment !== "production" ||
    value.operation !== "cutover" ||
    value.smokeAuthorization !== "exact-one-l4-250-jpy" ||
    !commitPattern.test(value.commitSha) ||
    !runPattern.test(value.cutoverRunId) ||
    !runPattern.test(value.stagingRunId)
  ) {
    throw new Error("Production cutover evidence is invalid");
  }
  return { ...value };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, directory] = process.argv.slice(2);
  try {
    if (!new Set(["create", "verify"]).has(command) || directory === undefined) {
      throw new Error("Usage: production-cutover-evidence <create|verify> <directory>");
    }
    const evidencePath = path.resolve(directory, "production-cutover.json");
    if (command === "create") {
      const evidence = validateProductionCutoverEvidence({
        commitSha: process.env.EXPECTED_COMMIT_SHA,
        cutoverRunId: process.env.GITHUB_RUN_ID,
        environment: "production",
        operation: process.env.PRODUCTION_OPERATION,
        schemaVersion: 1,
        smokeAuthorization: "exact-one-l4-250-jpy",
        stagingRunId: process.env.STAGING_RUN_ID,
      });
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
    }
    const evidence = validateProductionCutoverEvidence(
      JSON.parse(readFileSync(evidencePath, "utf8")),
    );
    if (
      (process.env.EXPECTED_COMMIT_SHA !== undefined &&
        evidence.commitSha !== process.env.EXPECTED_COMMIT_SHA) ||
      (process.env.EXPECTED_CUTOVER_RUN_ID !== undefined &&
        evidence.cutoverRunId !== process.env.EXPECTED_CUTOVER_RUN_ID) ||
      (process.env.EXPECTED_STAGING_RUN_ID !== undefined &&
        evidence.stagingRunId !== process.env.EXPECTED_STAGING_RUN_ID)
    ) {
      throw new Error("Production cutover evidence identity does not match");
    }
    console.log(`Verified production cutover run ${evidence.cutoverRunId}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production cutover evidence failed");
    process.exitCode = 1;
  }
}
