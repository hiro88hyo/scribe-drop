import { createHash } from "node:crypto";

const commitShaPattern = /^[0-9a-f]{40}$/u;
const accountIdPattern = /^[0-9a-f]{32}$/u;
const configHashPattern = /^[0-9a-f]{64}$/u;
const projectNamePattern = /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireResponseEnvelope(value, name) {
  const envelope = requireRecord(value, `${name} response`);
  if (envelope.success !== true || !("result" in envelope)) {
    throw new Error(`${name} response is invalid`);
  }
  return envelope.result;
}

function requireInput(input) {
  if (
    typeof input.accountId !== "string" ||
    !accountIdPattern.test(input.accountId) ||
    typeof input.apiToken !== "string" ||
    input.apiToken.length === 0 ||
    typeof input.branch !== "string" ||
    input.branch !== "develop" ||
    typeof input.commitSha !== "string" ||
    !commitShaPattern.test(input.commitSha) ||
    typeof input.configContents !== "string" ||
    input.configContents.length === 0 ||
    typeof input.projectName !== "string" ||
    !projectNamePattern.test(input.projectName)
  ) {
    throw new Error("Pages promotion input is invalid");
  }
  return {
    ...input,
    configHash: createHash("sha256").update(input.configContents).digest("hex"),
  };
}

async function fetchJson(fetchImplementation, url, apiToken, name) {
  let response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${name} request failed`);
  }
  if (!response.ok) {
    throw new Error(`${name} request failed with status ${String(response.status)}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${name} response is not JSON`);
  }
}

export function validatePagesPromotionState(value, expected) {
  const project = requireRecord(
    requireResponseEnvelope(value.project, "Cloudflare Pages project"),
    "Cloudflare Pages project",
  );
  const configuredHash = project.deployment_configs?.production?.wrangler_config_hash;
  if (
    project.name !== expected.projectName ||
    project.production_branch !== expected.branch ||
    typeof configuredHash !== "string" ||
    !configHashPattern.test(configuredHash)
  ) {
    throw new Error("Cloudflare Pages project configuration is invalid");
  }

  const deployments = requireResponseEnvelope(value.deployments, "Cloudflare Pages deployments");
  if (!Array.isArray(deployments)) {
    throw new Error("Cloudflare Pages deployments response is invalid");
  }
  const latest = deployments[0];
  if (latest === undefined) {
    return {
      exact: false,
      hasExpectedCommit: false,
      invalidExpectedCommit: false,
      reason: "missing",
    };
  }
  const deployment = requireRecord(latest, "Cloudflare Pages deployment");
  const trigger = requireRecord(
    deployment.deployment_trigger,
    "Cloudflare Pages deployment trigger",
  );
  const metadata = requireRecord(trigger.metadata, "Cloudflare Pages deployment trigger metadata");
  const latestStage = requireRecord(deployment.latest_stage, "Cloudflare Pages deployment stage");
  if (
    deployment.project_name !== expected.projectName ||
    deployment.environment !== "production" ||
    typeof metadata.commit_hash !== "string" ||
    !commitShaPattern.test(metadata.commit_hash) ||
    metadata.branch !== expected.branch ||
    typeof latestStage.name !== "string" ||
    typeof latestStage.status !== "string"
  ) {
    throw new Error("Cloudflare Pages deployment identity is invalid");
  }

  const hasExpectedCommit = metadata.commit_hash === expected.commitSha;
  const stageSucceeded = latestStage.name === "deploy" && latestStage.status === "success";
  const exact =
    hasExpectedCommit &&
    stageSucceeded &&
    deployment.is_skipped === false &&
    deployment.uses_functions === true &&
    configuredHash === expected.configHash;
  const terminalStage = new Set(["failure", "canceled"]).has(latestStage.status);
  const invalidExpectedCommit =
    hasExpectedCommit &&
    (terminalStage ||
      (stageSucceeded && (deployment.is_skipped !== false || deployment.uses_functions !== true)));

  return {
    exact,
    hasExpectedCommit,
    invalidExpectedCommit,
    reason: exact
      ? "exact"
      : invalidExpectedCommit
        ? "invalid-candidate"
        : hasExpectedCommit
          ? "candidate-pending-or-config-drift"
          : "different-candidate",
  };
}

export async function readPagesPromotionState(input, dependencies = {}) {
  const validated = requireInput(input);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const projectPath = `${encodeURIComponent(validated.projectName)}`;
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${validated.accountId}/pages/projects/${projectPath}`;
  const [project, deployments] = await Promise.all([
    fetchJson(fetchImplementation, baseUrl, validated.apiToken, "Cloudflare Pages project"),
    fetchJson(
      fetchImplementation,
      `${baseUrl}/deployments?env=production&page=1&per_page=1`,
      validated.apiToken,
      "Cloudflare Pages deployments",
    ),
  ]);
  return validatePagesPromotionState(
    { deployments, project },
    {
      branch: validated.branch,
      commitSha: validated.commitSha,
      configHash: validated.configHash,
      projectName: validated.projectName,
    },
  );
}

async function waitForExactReadback(readState, wait, attempts, onRetry) {
  let lastState;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastState = await readState();
    if (lastState.exact) {
      return lastState;
    }
    if (lastState.invalidExpectedCommit) {
      throw new Error("Cloudflare Pages candidate deployment is terminally invalid");
    }
    if (attempt < attempts) {
      onRetry?.({ attempt, maximumAttempts: attempts });
      await wait(Math.min(2 ** (attempt - 1), 5) * 1_000);
    }
  }
  throw new Error(
    lastState?.hasExpectedCommit
      ? "Cloudflare Pages candidate deployment did not converge"
      : "Cloudflare Pages candidate deployment is not active",
  );
}

export async function promotePagesCandidate(input, dependencies) {
  const readState = dependencies.readState;
  const deploy = dependencies.deploy;
  const wait =
    dependencies.wait ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const attempts = dependencies.maximumReadbackAttempts ?? 6;
  if (
    typeof readState !== "function" ||
    typeof deploy !== "function" ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 10
  ) {
    throw new Error("Pages promotion dependencies are invalid");
  }

  const initial = await readState();
  if (initial.exact) {
    return { changed: false };
  }
  if (initial.invalidExpectedCommit) {
    throw new Error("Cloudflare Pages candidate deployment is terminally invalid");
  }
  if (initial.hasExpectedCommit) {
    await waitForExactReadback(readState, wait, attempts, dependencies.onReadRetry);
    return { changed: false };
  }

  let deploymentFailed = false;
  try {
    await deploy(input);
  } catch {
    deploymentFailed = true;
  }
  try {
    await waitForExactReadback(readState, wait, attempts, dependencies.onReadRetry);
  } catch {
    if (deploymentFailed) {
      throw new Error("Cloudflare Pages deployment outcome is unknown and read-back did not match");
    }
    throw new Error("Cloudflare Pages deployment read-back did not match");
  }
  return { changed: true };
}
