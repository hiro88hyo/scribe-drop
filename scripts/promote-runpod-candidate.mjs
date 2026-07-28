import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  parseMinimumAcceptanceRemainingMilliseconds,
  verifyStagingAcceptance,
} from "./release-acceptance.mjs";
import { runRunpodCliWithReadRetry } from "./runpod-cli-retry.mjs";
import { promoteRunpodCandidate, verifyRunpodPromotionPreflight } from "./runpod-promotion.mjs";
import { validateRunpodPlan } from "./runpod-environment-config.mjs";
import { clearRunpodTemplatePorts, listRunpodTemplates } from "./runpod-template-api.mjs";

const [environment, planPath] = process.argv.slice(2);
const preflightOnly = process.argv[4] === "--preflight-only";

function runCliOnce(arguments_) {
  const result = spawnSync(path.resolve(".tools", "bin", "runpodctl"), arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`runpodctl ${arguments_.slice(0, 2).join(" ")} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`runpodctl ${arguments_.slice(0, 2).join(" ")} returned invalid JSON`);
  }
}

function runCli(arguments_) {
  return runRunpodCliWithReadRetry(arguments_, runCliOnce, {
    onRetry({ attempt, command, maximumAttempts }) {
      console.warn(
        `Retrying read-only RunPod ${command} (${String(attempt)}/${String(maximumAttempts)})`,
      );
    },
  });
}

function listTemplates() {
  return listRunpodTemplates(
    { apiKey: process.env["RUNPOD_API_KEY"] },
    {
      onRetry({ attempt, command, maximumAttempts }) {
        console.warn(
          `Retrying read-only RunPod REST ${command} (${String(attempt)}/${String(
            maximumAttempts,
          )})`,
        );
      },
    },
  );
}

try {
  if (
    (environment !== "staging" && environment !== "production") ||
    planPath === undefined ||
    (process.argv.length !== 4 && !(process.argv.length === 5 && preflightOnly))
  ) {
    throw new Error(
      "Usage: promote-runpod-candidate <staging|production> <plan-path> [--preflight-only]",
    );
  }
  if (process.env["GITHUB_ACTIONS"] !== "true") {
    throw new Error("RunPod candidate promotion is restricted to GitHub Actions");
  }
  const expectedWorkflowSuffix = `/deploy-${environment}-candidate.yml@`;
  if (!String(process.env["GITHUB_WORKFLOW_REF"] ?? "").includes(expectedWorkflowSuffix)) {
    throw new Error("RunPod candidate promotion workflow identity is invalid");
  }
  if (environment === "production" && !preflightOnly) {
    const candidateDirectory = process.env["RELEASE_CANDIDATE_DIRECTORY"];
    const evidencePath = process.env["STAGING_ACCEPTANCE_PATH"];
    const expectedEnvironmentPolicyId = process.env["EXPECTED_ENVIRONMENT_POLICY_ID"];
    if (
      candidateDirectory === undefined ||
      evidencePath === undefined ||
      expectedEnvironmentPolicyId === undefined
    ) {
      throw new Error("Production promotion evidence is missing");
    }
    verifyStagingAcceptance({
      candidateDirectory,
      evidencePath,
      expectedCandidateRunId: process.env["EXPECTED_CANDIDATE_RUN_ID"],
      expectedCommitSha: process.env["GITHUB_SHA"],
      expectedEnvironmentPolicyId,
      expectedReleaseVersion: process.env["EXPECTED_RELEASE_VERSION"],
      expectedStagingRunId: process.env["EXPECTED_STAGING_RUN_ID"],
      minimumRemainingMilliseconds: parseMinimumAcceptanceRemainingMilliseconds(
        process.env["MINIMUM_ACCEPTANCE_REMAINING_SECONDS"],
      ),
    });
  }

  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}`;
  const endpointId = process.env[`${prefix}_RUNPOD_ENDPOINT_ID`];
  if (endpointId === undefined) {
    throw new Error(`RunPod ${environment} endpoint ID is missing`);
  }
  const plan = validateRunpodPlan(
    JSON.parse(readFileSync(path.resolve(planPath), "utf8")),
    environment,
  );
  if (preflightOnly) {
    const result = await verifyRunpodPromotionPreflight({
      endpointId,
      environment,
      listTemplates,
      plan,
      runCli,
    });
    console.log(
      `Verified RunPod ${environment} control-plane preflight (${
        result.candidateTemplatePortsRequireNormalization
          ? "candidate template port normalization pending"
          : result.candidateTemplateExists
            ? "candidate template ready"
            : "candidate template pending"
      }).`,
    );
    process.exit(0);
  }
  const result = await promoteRunpodCandidate({
    clearTemplatePorts(templateId) {
      return clearRunpodTemplatePorts({
        apiKey: process.env["RUNPOD_API_KEY"],
        templateId,
      });
    },
    endpointId,
    environment,
    listTemplates,
    plan,
    runCli,
  });
  const stateDirectory = path.resolve(".runpod", "deploy");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const statePath = path.join(stateDirectory, `${environment}-promotion-state.json`);
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environment,
        endpointId: result.endpointId,
        templateId: result.templateId,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(statePath, 0o600);
  console.log(
    `Verified RunPod ${environment} candidate promotion (${result.changed ? "updated" : "unchanged"}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "RunPod candidate promotion failed");
  process.exitCode = 1;
}
