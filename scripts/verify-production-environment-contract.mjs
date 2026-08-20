import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import { verifyProductionEnvironmentContract } from "./production-environment-contract.mjs";
import { acceptanceEvidencePath, validateStagingAcceptance } from "./release-acceptance.mjs";
import { verifyReleaseCandidate } from "./release-candidate.mjs";
import { fixedRunpodGpuTypeIds } from "./runpod-environment-config.mjs";

const repositoryPattern =
  /github\.com(?::|\/)(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u;

function run(command, arguments_, label) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${label} is unavailable`);
  return result.stdout.trim();
}

const [candidateDirectory, cloudRunCandidatePath, acceptanceDirectory, expectedCommitSha] =
  process.argv.slice(2);

try {
  if (
    candidateDirectory === undefined ||
    cloudRunCandidatePath === undefined ||
    acceptanceDirectory === undefined ||
    expectedCommitSha === undefined ||
    process.argv.length !== 6
  ) {
    throw new Error(
      "Usage: verify-production-environment-contract <candidate-directory> <cloud-run-candidate-evidence> <staging-acceptance-directory> <candidate-commit>",
    );
  }
  const remote = run("git", ["remote", "get-url", "origin"], "Git origin");
  const repository = repositoryPattern.exec(remote)?.groups?.repository;
  if (repository === undefined) throw new Error("GitHub repository identity is invalid");
  const response = JSON.parse(
    run(
      "gh",
      ["api", `repos/${repository}/environments/production/variables?per_page=100`],
      "Production Environment variables",
    ),
  );
  const acceptance = validateStagingAcceptance(
    JSON.parse(readFileSync(acceptanceEvidencePath(path.resolve(acceptanceDirectory)), "utf8")),
  );
  const candidate = verifyReleaseCandidate({
    candidateDirectory: path.resolve(candidateDirectory),
    expectedCommitSha,
    expectedReleaseVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
  });
  const cloudRunCandidate = parseCloudRunCandidateEvidence(
    JSON.parse(readFileSync(path.resolve(cloudRunCandidatePath), "utf8")),
  );
  if (
    acceptance.commitSha !== candidate.commitSha ||
    acceptance.cloudRunCandidate.commit !== cloudRunCandidate.commit ||
    acceptance.cloudRunCandidate.runId !== cloudRunCandidate.runId
  ) {
    throw new Error("Candidate and staging acceptance identities do not match");
  }
  const contractInput = {
    cloudRunCandidate,
    expectedEnvironmentPolicyId: acceptance.environmentPolicyId,
    runpodWorkerImage: candidate.runpodWorker.image,
    templates: {
      cors: readFileSync("infra/cloudflare/r2-cors.production.json", "utf8"),
      lifecycle: readFileSync("infra/cloudflare/r2-lifecycle.production.json", "utf8"),
      orchestrator: readFileSync("apps/orchestrator/wrangler.toml", "utf8"),
      web: readFileSync("apps/web/wrangler.production.toml", "utf8"),
    },
    variables: response.variables,
  };
  let result;
  try {
    result = verifyProductionEnvironmentContract(contractInput);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS")
    ) {
      throw error;
    }
    const correctedVariables = response.variables.map((variable) =>
      variable?.name === "SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS"
        ? { ...variable, value: fixedRunpodGpuTypeIds.join(",") }
        : variable,
    );
    const corrected = verifyProductionEnvironmentContract({
      ...contractInput,
      variables: correctedVariables,
    });
    throw new Error(
      `${error.message}; reviewed GPU correction would satisfy all ${corrected.variableCount} values and staging parity`,
      { cause: error },
    );
  }
  console.log(
    `Verified ${result.variableCount} production Environment values and staging parity ${result.policyId}.`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Production Environment contract is invalid",
  );
  process.exitCode = 1;
}
