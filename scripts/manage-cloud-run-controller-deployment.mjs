import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import {
  controllerDeployment,
  createControllerAuthorization,
  createControllerDeploymentConfiguration,
  createControllerServiceRequest,
  isAllowedControllerDisable,
  isExactControllerAuthorizationRetry,
} from "./cloud-run-controller-deployment.mjs";

const PROJECT_ID = "scribe-drop";
const PROJECT_NUMBER = "601035271372";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$/u;
const secretVersionPattern = /^[1-9][0-9]*$/u;

function requireValue(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireExactOrigin(value, name) {
  if (typeof value !== "string") throw new Error(`${name} is missing or invalid`);
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function authorization(mode) {
  const integer = (value) =>
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : undefined;
  return createControllerAuthorization({
    environment: selectedEnvironment,
    epoch: process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH,
    maxExecutions: integer(process.env.SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS),
    maxWorstCaseJpy: integer(process.env.SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY),
    mode,
    now: new Date(),
    validUntil: process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL,
  });
}

async function googleRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-goog-user-project": PROJECT_ID,
      ...init.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.length > 512 * 1024) throw new Error("Google API response exceeded the safe limit");
  let body;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new Error(`Google API returned non-JSON status ${response.status}`);
  }
  return { body, status: response.status };
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function stringValue(value) {
  return { stringValue: value };
}

function authorizationDocumentBody(selected) {
  return {
    fields: {
      activeExecutionHandle: { nullValue: null },
      activeExecutions: integerValue(0),
      environment: stringValue(selected.environment),
      epoch: stringValue(selected.epoch),
      maxExecutions: integerValue(selected.maxExecutions),
      maxRequestsPerMinute: integerValue(selected.maxRequestsPerMinute),
      maxWorstCaseJpy: integerValue(selected.maxWorstCaseJpy),
      policyId: stringValue("cloud_run_jobs_l4_v1"),
      recentAcceptedAt: { arrayValue: { values: [] } },
      reservedExecutions: integerValue(0),
      reservedWorstCaseJpy: integerValue(0),
      schemaVersion: integerValue(1),
      updatedAt: stringValue(new Date().toISOString()),
      validUntil: stringValue(selected.validUntil),
      worstCaseJpyPerExecution: integerValue(selected.worstCaseJpyPerExecution),
    },
  };
}

function integerField(document, name) {
  const value = document?.fields?.[name]?.integerValue;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Controller authorization document is invalid");
  }
  return Number(value);
}

function stringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  if (typeof value !== "string") throw new Error("Controller authorization document is invalid");
  return value;
}

async function writeAuthorization(selected, expectedReservedExecutions) {
  const documentUrl =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${deployment.databaseId}` +
    `/documents/scribe_drop_controller_environments/${selectedEnvironment}`;
  const current = await googleRequest(documentUrl, { method: "GET" });
  if (current.status !== 200 && current.status !== 404) {
    throw new Error(`Controller authorization read failed: ${current.status}`);
  }
  if (current.status === 200 && integerField(current.body, "activeExecutions") !== 0) {
    throw new Error("Controller authorization cannot change while capacity is reserved");
  }
  if (
    selected.epoch === "disabled" &&
    ((current.status === 404 && expectedReservedExecutions !== 0) ||
      (current.status === 200 &&
        !isAllowedControllerDisable(
          {
            activeExecutions: integerField(current.body, "activeExecutions"),
            epoch: stringField(current.body, "epoch"),
            maxExecutions: integerField(current.body, "maxExecutions"),
            maxWorstCaseJpy: integerField(current.body, "maxWorstCaseJpy"),
            reservedExecutions: integerField(current.body, "reservedExecutions"),
            reservedWorstCaseJpy: integerField(current.body, "reservedWorstCaseJpy"),
            worstCaseJpyPerExecution: integerField(current.body, "worstCaseJpyPerExecution"),
          },
          expectedReservedExecutions,
        )))
  ) {
    throw new Error("Controller disable reservation expectation does not match");
  }
  if (current.status === 200 && selected.epoch !== "disabled") {
    const reservedExecutions = integerField(current.body, "reservedExecutions");
    const reservedWorstCaseJpy = integerField(current.body, "reservedWorstCaseJpy");
    const currentEpoch = stringField(current.body, "epoch");
    const exactRetry = isExactControllerAuthorizationRetry(selected, {
      activeExecutions: integerField(current.body, "activeExecutions"),
      environment: stringField(current.body, "environment"),
      epoch: currentEpoch,
      maxExecutions: integerField(current.body, "maxExecutions"),
      maxRequestsPerMinute: integerField(current.body, "maxRequestsPerMinute"),
      maxWorstCaseJpy: integerField(current.body, "maxWorstCaseJpy"),
      reservedExecutions,
      reservedWorstCaseJpy,
      validUntil: stringField(current.body, "validUntil"),
      worstCaseJpyPerExecution: integerField(current.body, "worstCaseJpyPerExecution"),
    });
    if (exactRetry) return;
    if (currentEpoch !== "disabled" || reservedExecutions !== 0 || reservedWorstCaseJpy !== 0) {
      throw new Error("A finite authorization must start from the disabled zero state");
    }
  }
  const condition = new URLSearchParams();
  if (current.status === 200) {
    const updateTime = requireValue(
      current.body.updateTime,
      /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/u,
      "Controller authorization update time",
    );
    condition.set("currentDocument.updateTime", updateTime);
  } else {
    condition.set("currentDocument.exists", "false");
  }
  const written = await googleRequest(`${documentUrl}?${condition.toString()}`, {
    body: JSON.stringify(authorizationDocumentBody(selected)),
    method: "PATCH",
  });
  if (written.status !== 200) {
    throw new Error(`Controller authorization update failed: ${written.status}`);
  }
}

async function waitForOperation(operation) {
  let current = operation;
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Cloud Run operation is invalid");
  }
  requireValue(current.name, /^projects\/.+\/operations\/.+$/u, "Cloud Run operation name");
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (current.done === true) {
      if (current.error !== undefined) throw new Error("Cloud Run Service operation failed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const read = await googleRequest(`https://run.googleapis.com/v2/${current.name}`, {
      method: "GET",
    });
    if (read.status !== 200) throw new Error(`Cloud Run operation read failed: ${read.status}`);
    current = read.body;
  }
  throw new Error("Cloud Run Service operation did not converge");
}

async function deployService(plan) {
  const query = new URLSearchParams({ allowMissing: "true", updateMask: "*" });
  const response = await googleRequest(
    `https://run.googleapis.com/v2/${plan.name}?${query.toString()}`,
    { body: JSON.stringify(createControllerServiceRequest(plan)), method: "PATCH" },
  );
  if (response.status !== 200) {
    throw new Error(`Cloud Run Service update failed: ${response.status}`);
  }
  await waitForOperation(response.body);
}

async function readAndVerify(deploymentConfiguration) {
  const { GoogleControllerDeploymentReadbackClient } =
    await import("../apps/gpu-controller/dist/index.js");
  return new GoogleControllerDeploymentReadbackClient({
    getAccessToken: async () => accessToken,
  }).readAndVerify({
    binaryAuthorization: {
      attestors: [`projects/${PROJECT_ID}/attestors/scribe-drop-release-candidate`],
      projectId: PROJECT_ID,
    },
    deployment: deploymentConfiguration,
    projectNumber: PROJECT_NUMBER,
  });
}

const [command, selectedEnvironment, authorizationMode, candidatePath] = process.argv.slice(2);
if (
  !new Set(["apply", "read"]).has(command) ||
  !new Set(["staging", "production"]).has(selectedEnvironment) ||
  !new Set(["disabled", "operational", "smoke"]).has(authorizationMode) ||
  candidatePath === undefined ||
  process.argv.length !== 6
) {
  throw new Error(
    "Usage: manage-cloud-run-controller-deployment <apply|read> <staging|production> <disabled|operational|smoke> <candidate-evidence>",
  );
}
const deployment = controllerDeployment(selectedEnvironment);
const environmentPrefix = `SCRIBE_DROP_${selectedEnvironment.toUpperCase()}`;
const accessToken = requireValue(
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
  tokenPattern,
  "Google OAuth access token",
);
const orchestratorOrigin = requireExactOrigin(
  process.env[`${environmentPrefix}_ORCHESTRATOR_ORIGIN`],
  `${selectedEnvironment} Orchestrator origin`,
);
const r2Host = requireValue(
  process.env[`${environmentPrefix}_R2_HOST`],
  hostnamePattern,
  `${selectedEnvironment} R2 host`,
);
const primarySecretVersion = requireValue(
  process.env[`${environmentPrefix}_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION`],
  secretVersionPattern,
  `${selectedEnvironment} controller HMAC secret version`,
);
const candidate = parseCloudRunCandidateEvidence(
  JSON.parse(readFileSync(path.resolve(candidatePath), "utf8")),
);
if (candidate.commit !== process.env.EXPECTED_COMMIT_SHA) {
  throw new Error("Cloud Run candidate commit does not match");
}
const selectedAuthorization = authorization(authorizationMode);
const expectedDisabledReservations = (() => {
  const value = process.env.SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS ?? "0";
  if (!/^[01]$/u.test(value) || (authorizationMode !== "disabled" && value !== "0")) {
    throw new Error("Controller disable reservation expectation is invalid");
  }
  return Number(value);
})();
const deploymentConfiguration = createControllerDeploymentConfiguration({
  authorization: selectedAuthorization,
  candidate,
  environment: selectedEnvironment,
  orchestratorOrigin,
  primarySecretVersion,
  r2Host,
});

try {
  const { createControllerServiceDeploymentPlan } =
    await import("../apps/gpu-controller/dist/index.js");
  const plan = createControllerServiceDeploymentPlan(deploymentConfiguration);
  if (command === "apply") {
    if (authorizationMode !== "disabled") {
      await deployService(plan);
      await writeAuthorization(selectedAuthorization, expectedDisabledReservations);
    } else {
      await deployService(plan);
      await writeAuthorization(selectedAuthorization, expectedDisabledReservations);
    }
  }
  const evidence = await readAndVerify(deploymentConfiguration);
  console.log(
    JSON.stringify({
      authorization: authorizationMode,
      environment: selectedEnvironment,
      firestoreTtlFieldCount: evidence.firestore.ttlStates.length,
      serviceReady: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud Run controller deployment failed");
  process.exitCode = 1;
}
