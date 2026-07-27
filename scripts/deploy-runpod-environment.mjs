import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createRunpodEndpointArguments,
  createRunpodTemplateArguments,
  validateCreatedRunpodEndpoint,
  validateCreatedRunpodTemplate,
  validateRunpodPlan,
} from "./runpod-environment-config.mjs";

const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  throw new Error("Expected RunPod environment: staging or production");
}
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const runpodctl = path.join(repositoryRoot, ".tools", "bin", "runpodctl");
const deploymentDirectory = path.join(repositoryRoot, ".runpod", "deploy");
const planPath = path.join(deploymentDirectory, `${environment}-plan.json`);
const statePath = path.join(deploymentDirectory, `${environment}-state.json`);

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function readJson(pathname, name) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    throw new Error(`${name} is missing or invalid`);
  }
}

function planSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function writeState(state) {
  mkdirSync(deploymentDirectory, { recursive: true, mode: 0o700 });
  chmodSync(deploymentDirectory, 0o700);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(statePath, 0o600);
}

function loadState(expectedPlanSha256) {
  if (!existsSync(statePath)) {
    return null;
  }
  const state = requireRecord(
    readJson(statePath, `RunPod ${environment} state`),
    `RunPod ${environment} state`,
  );
  if (
    state.schemaVersion !== 1 ||
    state.environment !== environment ||
    state.planSha256 !== expectedPlanSha256 ||
    !resourceIdPattern.test(String(state.templateId ?? "")) ||
    (state.endpointId !== null && !resourceIdPattern.test(String(state.endpointId ?? "")))
  ) {
    throw new Error(`RunPod ${environment} state does not match the current plan`);
  }
  return state;
}

function runCli(arguments_) {
  const result = spawnSync(runpodctl, arguments_, {
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

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} returned an invalid response`);
  }
  return value;
}

function matchingNamedResources(resources, name) {
  return resources.filter(
    (resource) =>
      typeof resource === "object" &&
      resource !== null &&
      !Array.isArray(resource) &&
      resource.name === name,
  );
}

function getOrCreateTemplate(plan, state) {
  if (state !== null) {
    const template = runCli(["template", "get", state.templateId]);
    validateCreatedRunpodTemplate(template, plan);
    return state.templateId;
  }

  const templates = requireArray(
    runCli(["template", "list", "--type", "user"]),
    "runpodctl template list",
  );
  const matches = matchingNamedResources(templates, plan.template.name);
  if (matches.length > 1) {
    throw new Error("multiple RunPod templates match the immutable plan");
  }
  if (matches.length === 1) {
    const summary = requireRecord(matches[0], "RunPod template response");
    if (!resourceIdPattern.test(String(summary.id ?? ""))) {
      throw new Error("RunPod template response is missing an ID");
    }
    return validateCreatedRunpodTemplate(runCli(["template", "get", summary.id]), plan);
  }

  const created = runCli(createRunpodTemplateArguments(plan));
  return validateCreatedRunpodTemplate(created, plan);
}

function getOrCreateEndpoint(plan, templateId, state) {
  if (state?.endpointId !== null && state?.endpointId !== undefined) {
    const endpoint = runCli([
      "serverless",
      "get",
      state.endpointId,
      "--include-template",
      "--include-workers",
    ]);
    validateCreatedRunpodEndpoint(endpoint, plan, templateId);
    return state.endpointId;
  }

  const endpoints = requireArray(runCli(["serverless", "list"]), "runpodctl serverless list");
  const matches = matchingNamedResources(endpoints, plan.endpoint.name);
  if (matches.length > 1) {
    throw new Error(`multiple RunPod endpoints match the ${environment} name`);
  }
  if (matches.length === 1) {
    if (state === null) {
      throw new Error("existing RunPod endpoint has no matching pending deployment state");
    }
    const summary = requireRecord(matches[0], "RunPod endpoint response");
    if (!resourceIdPattern.test(String(summary.id ?? ""))) {
      throw new Error("RunPod endpoint response is missing an ID");
    }
    const endpoint = runCli([
      "serverless",
      "get",
      summary.id,
      "--include-template",
      "--include-workers",
    ]);
    return validateCreatedRunpodEndpoint(endpoint, plan, templateId);
  }

  const created = runCli(createRunpodEndpointArguments(plan, templateId));
  return validateCreatedRunpodEndpoint(created, plan, templateId);
}

function main() {
  if (process.argv.length !== 3) {
    throw new Error("RunPod deployment takes exactly one environment argument");
  }
  if (environment === "production") {
    throw new Error(
      "Production RunPod deployment is blocked until the ADR 0023 promotion gate is implemented",
    );
  }
  if (!existsSync(runpodctl)) {
    throw new Error("runpodctl is not installed; run pnpm run runpodctl:install");
  }
  const plan = validateRunpodPlan(readJson(planPath, `RunPod ${environment} plan`), environment);
  const planDigest = planSha256(plan);
  const state = loadState(planDigest);

  runCli(["user"]);
  const templateId = getOrCreateTemplate(plan, state);
  if (state === null) {
    writeState({
      schemaVersion: 1,
      environment,
      planSha256: planDigest,
      templateId,
      endpointId: null,
    });
  }

  const endpointId = getOrCreateEndpoint(plan, templateId, state);
  const endpoint = runCli([
    "serverless",
    "get",
    endpointId,
    "--include-template",
    "--include-workers",
  ]);
  validateCreatedRunpodEndpoint(endpoint, plan, templateId);
  writeState({
    schemaVersion: 1,
    environment,
    planSha256: planDigest,
    templateId,
    endpointId,
  });
  console.log(
    `Verified RunPod ${environment} template and endpoint; IDs are stored only in ignored state.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : `RunPod ${environment} deployment failed`);
  process.exitCode = 1;
}
