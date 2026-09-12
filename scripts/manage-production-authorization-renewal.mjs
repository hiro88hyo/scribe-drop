import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  classifyProductionAuthorizationRenewal,
  createPreviousProductionAuthorization,
  createProductionAuthorizationRenewal,
  firestoreAuthorizationPatch,
  parseProductionAuthorizationDocument,
  parseProductionControllerService,
  productionAuthorizationRenewalTarget,
  serviceAuthorizationEnvironment,
} from "./production-authorization-renewal.mjs";

const DATABASE_ID = "scribe-production-controller";
const DOCUMENT_PATH = "scribe_drop_controller_environments/production";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;
const imagePattern =
  /^asia-southeast1-docker\.pkg\.dev\/scribe-drop\/controller\/runtime@sha256:[0-9a-f]{64}$/u;

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function inputState(now = new Date()) {
  const previous = createPreviousProductionAuthorization({
    epoch: requiredEnvironment(
      "PREVIOUS_PRODUCTION_AUTHORIZATION_EPOCH",
      /^phase16-operational-[a-f0-9]{7,40}-[1-9][0-9]*$/u,
    ),
    maxExecutions: requiredEnvironment(
      "PREVIOUS_PRODUCTION_AUTHORIZATION_MAX_EXECUTIONS",
      /^(?:[1-9]|1[0-9]|20)$/u,
    ),
    now,
    validUntil: requiredEnvironment(
      "PREVIOUS_PRODUCTION_AUTHORIZATION_VALID_UNTIL",
      /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/u,
    ),
  });
  const desired = createProductionAuthorizationRenewal({
    maxExecutions: requiredEnvironment(
      "PRODUCTION_AUTHORIZATION_MAX_EXECUTIONS",
      /^(?:[1-9]|1[0-9]|20)$/u,
    ),
    maxWorstCaseJpy: requiredEnvironment(
      "PRODUCTION_AUTHORIZATION_MAX_WORST_CASE_JPY",
      /^[1-9][0-9]{2,3}$/u,
    ),
    now,
    previousEpoch: previous.epoch,
    runId: requiredEnvironment("GITHUB_RUN_ID", /^[1-9][0-9]{0,14}$/u),
    validUntil: requiredEnvironment(
      "PRODUCTION_AUTHORIZATION_VALID_UNTIL",
      /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/u,
    ),
  });
  return {
    desired,
    expectedImageDigest: requiredEnvironment("EXPECTED_CONTROLLER_IMAGE_DIGEST", imagePattern),
    now,
    previous,
  };
}

function gcloud(arguments_) {
  const result = spawnSync("gcloud", arguments_, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Pinned gcloud operation failed");
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function googleRequest(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-goog-user-project": productionAuthorizationRenewalTarget.projectId,
      ...init.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (text.length > 512 * 1024) throw new Error("Google API response exceeded the safe limit");
  return {
    body: parseJson(text, "Google API"),
    status: response.status,
  };
}

function authorizationDocumentUrl() {
  return (
    `https://firestore.googleapis.com/v1/projects/${productionAuthorizationRenewalTarget.projectId}` +
    `/databases/${DATABASE_ID}/documents/${DOCUMENT_PATH}`
  );
}

function readService() {
  const body = parseJson(
    gcloud([
      "run",
      "services",
      "describe",
      productionAuthorizationRenewalTarget.serviceName,
      `--project=${productionAuthorizationRenewalTarget.projectId}`,
      `--region=${productionAuthorizationRenewalTarget.region}`,
      "--format=json",
    ]),
    "Production controller Service read",
  );
  return parseProductionControllerService(body);
}

async function readDocument(token) {
  const response = await googleRequest(authorizationDocumentUrl(), token, { method: "GET" });
  if (response.status !== 200) {
    throw new Error(`Production authorization read failed: ${response.status}`);
  }
  return parseProductionAuthorizationDocument(response.body);
}

async function readSnapshot(state, token) {
  const service = readService();
  if (service.imageDigest !== state.expectedImageDigest) {
    throw new Error("Production controller image does not match the approved immutable digest");
  }
  const document = await readDocument(token);
  return {
    document,
    service,
    stage: classifyProductionAuthorizationRenewal({
      desired: state.desired,
      document,
      now: state.now,
      previous: state.previous,
      service,
    }),
  };
}

function listedResources(arguments_, label) {
  const value = parseJson(gcloud(arguments_), label);
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value.length;
}

function requireNoExistingGpuLifecycle() {
  const common = [
    `--project=${productionAuthorizationRenewalTarget.projectId}`,
    `--region=${productionAuthorizationRenewalTarget.region}`,
    "--format=json",
  ];
  const jobs = listedResources(["run", "jobs", "list", ...common], "Cloud Run Job list");
  const executions = listedResources(
    ["run", "jobs", "executions", "list", ...common],
    "Cloud Run Execution list",
  );
  if (jobs !== 0 || executions !== 0) {
    throw new Error("Expired production authorization still has a Cloud Run GPU lifecycle");
  }
}

function safeSummary(state, snapshot) {
  return {
    activeExecutions: snapshot.document.activeExecutions,
    epoch: state.desired.epoch,
    imageDigest: snapshot.service.imageDigest,
    maxExecutions: state.desired.maxExecutions,
    maxWorstCaseJpy: state.desired.maxWorstCaseJpy,
    reservedExecutions: snapshot.document.reservedExecutions,
    stage: snapshot.stage,
    validUntil: state.desired.validUntil,
  };
}

async function preflight(state, token) {
  const snapshot = await readSnapshot(state, token);
  if (snapshot.stage !== "active") requireNoExistingGpuLifecycle();
  process.stdout.write(`${JSON.stringify(safeSummary(state, snapshot))}\n`);
}

async function applyService(state, token) {
  const before = await readSnapshot(state, token);
  if (before.stage === "active" || before.stage === "service-updated") {
    process.stdout.write(`${JSON.stringify(safeSummary(state, before))}\n`);
    return;
  }
  const environment = Object.entries(serviceAuthorizationEnvironment(state.desired))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
  gcloud([
    "run",
    "services",
    "update",
    productionAuthorizationRenewalTarget.serviceName,
    `--project=${productionAuthorizationRenewalTarget.projectId}`,
    `--region=${productionAuthorizationRenewalTarget.region}`,
    `--update-env-vars=${environment}`,
    "--quiet",
    "--format=json",
  ]);
  const after = await readSnapshot(state, token);
  if (after.stage !== "service-updated" && after.stage !== "active") {
    throw new Error("Production controller Service renewal did not converge");
  }
  process.stdout.write(`${JSON.stringify(safeSummary(state, after))}\n`);
}

async function applyFirestore(state, token) {
  const before = await readSnapshot(state, token);
  if (before.stage === "active") {
    process.stdout.write(`${JSON.stringify(safeSummary(state, before))}\n`);
    return;
  }
  if (before.stage !== "service-updated" || before.document.activeExecutions !== 0) {
    throw new Error("Production authorization renewal is not ready for the Firestore mutation");
  }
  const updatedAt = new Date().toISOString();
  const patch = firestoreAuthorizationPatch(state.desired, before.document.updateTime, updatedAt);
  const parameters = new URLSearchParams();
  for (const field of Object.keys(patch.body.fields)) {
    parameters.append("updateMask.fieldPaths", field);
  }
  parameters.set("currentDocument.updateTime", patch.updateTime);
  const response = await googleRequest(
    `${authorizationDocumentUrl()}?${parameters.toString()}`,
    token,
    { body: JSON.stringify(patch.body), method: "PATCH" },
  );
  if (response.status !== 200) {
    throw new Error(`Production authorization update failed: ${response.status}`);
  }
  const after = await readSnapshot(state, token);
  if (after.stage !== "active") {
    throw new Error("Production authorization renewal did not converge");
  }
  process.stdout.write(`${JSON.stringify(safeSummary(state, after))}\n`);
}

async function verify(state, token) {
  const snapshot = await readSnapshot(state, token);
  if (snapshot.stage !== "active") {
    throw new Error("Production authorization renewal is incomplete");
  }
  process.stdout.write(`${JSON.stringify(safeSummary(state, snapshot))}\n`);
  return snapshot;
}

async function writeEvidence(state, token, outputPath) {
  if (typeof outputPath !== "string" || !/^[\x20-\x7e]{1,1024}$/u.test(outputPath)) {
    throw new Error("Production authorization evidence path is invalid");
  }
  const snapshot = await verify(state, token);
  const evidence = {
    ...safeSummary(state, snapshot),
    generatedAt: new Date().toISOString(),
    projectId: productionAuthorizationRenewalTarget.projectId,
    region: productionAuthorizationRenewalTarget.region,
    schemaVersion: 1,
    serviceName: productionAuthorizationRenewalTarget.serviceName,
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

const command = process.argv[2];
if (
  !new Set(["inputs", "preflight", "apply-service", "apply-firestore", "verify", "evidence"]).has(
    command,
  )
) {
  throw new Error(
    "Usage: manage-production-authorization-renewal <inputs|preflight|apply-service|apply-firestore|verify|evidence> [evidence-path]",
  );
}

const state = inputState();
if (command === "inputs") {
  process.stdout.write(
    `${JSON.stringify({
      epoch: state.desired.epoch,
      imageDigest: state.expectedImageDigest,
      maxExecutions: state.desired.maxExecutions,
      maxWorstCaseJpy: state.desired.maxWorstCaseJpy,
      validUntil: state.desired.validUntil,
    })}\n`,
  );
} else {
  const token = requiredEnvironment("GOOGLE_OAUTH_ACCESS_TOKEN", tokenPattern);
  if (command === "preflight") await preflight(state, token);
  if (command === "apply-service") await applyService(state, token);
  if (command === "apply-firestore") await applyFirestore(state, token);
  if (command === "verify") await verify(state, token);
  if (command === "evidence") await writeEvidence(state, token, process.argv[3]);
}
