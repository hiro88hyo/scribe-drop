import { isDeepStrictEqual } from "node:util";

const accountIdPattern = /^[0-9a-f]{32}$/u;
const gpuIdPattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,126}[A-Za-z0-9]$/u;
const imagePattern =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/scribe-drop-runpod-worker@sha256:[0-9a-f]{64}$/u;
const registryAuthIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const r2HostPattern = /^([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/u;

const containerDiskInGb = 30;
const executionTimeoutSeconds = 6 * 60 * 60;
const heartbeatIntervalSeconds = 120;
const idleTimeoutSeconds = 5;
const maxDurationSeconds = 8 * 60 * 60;
const maxSourceBytes = 2 * 1024 * 1024 * 1024;
const minimumAvailableGpuFallbacks = 2;
const fixedGpuTypeIds = ["NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 4090"];

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or has an invalid format`);
  }
  return value;
}

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireExactHttpsOrigin(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} is missing or invalid`);
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error(`${name} is missing or invalid`);
  }

  return value;
}

function requireEnvironment(value) {
  if (value !== "staging" && value !== "production") {
    throw new Error("RunPod environment must be staging or production");
  }
  return value;
}

function environmentVariablePrefix(environment) {
  return `SCRIBE_DROP_${environment.toUpperCase()}_RUNPOD`;
}

function rejectMixedEnvironment(value, environment, name) {
  const forbidden = environment === "production" ? "staging" : "production";
  if (value.toLowerCase().includes(forbidden)) {
    throw new Error(`${name} must not contain a ${forbidden} environment marker`);
  }
}

function requireGpuTypeIds(value, environment) {
  const name = `${environmentVariablePrefix(environment)}_GPU_IDS`;
  if (typeof value !== "string") {
    throw new Error(`${name} is missing or invalid`);
  }
  const values = value.split(",").map((candidate) => candidate.trim());
  if (
    values.length === 0 ||
    values.length > 3 ||
    values.some((candidate) => !gpuIdPattern.test(candidate)) ||
    new Set(values).size !== values.length ||
    !isDeepStrictEqual(values, fixedGpuTypeIds)
  ) {
    throw new Error(`${name} is missing or invalid`);
  }
  return values;
}

function requireRegistryConfiguration(input, environment) {
  const prefix = environmentVariablePrefix(environment);
  if (input.imageVisibility !== "private" && input.imageVisibility !== "public") {
    throw new Error(`${prefix}_IMAGE_VISIBILITY must be private or public`);
  }

  if (input.imageVisibility === "private") {
    const registryAuthId = requirePattern(
      input.registryAuthId,
      registryAuthIdPattern,
      `${prefix}_REGISTRY_AUTH_ID`,
    );
    rejectMixedEnvironment(registryAuthId, environment, `${prefix}_REGISTRY_AUTH_ID`);
    return registryAuthId;
  }
  if (input.registryAuthId !== undefined && input.registryAuthId !== "") {
    throw new Error("public RunPod image must not use registry authentication");
  }
  return null;
}

export function createRunpodPlan(input, untrustedEnvironment) {
  const environment = requireEnvironment(untrustedEnvironment);
  const prefix = environmentVariablePrefix(environment);
  const accountId = requirePattern(input.accountId, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID");
  const image = requirePattern(input.image, imagePattern, `${prefix}_IMAGE`);
  const imageDigest = image.slice(image.indexOf("sha256:") + "sha256:".length);
  const orchestratorOrigin = requireExactHttpsOrigin(
    input.orchestratorOrigin,
    `SCRIBE_DROP_${environment.toUpperCase()}_ORCHESTRATOR_ORIGIN`,
  );
  rejectMixedEnvironment(
    orchestratorOrigin,
    environment,
    `SCRIBE_DROP_${environment.toUpperCase()}_ORCHESTRATOR_ORIGIN`,
  );
  const registryAuthId = requireRegistryConfiguration(input, environment);
  const r2Host = `${accountId}.r2.cloudflarestorage.com`;

  return {
    schemaVersion: 1,
    environment,
    imageVisibility: input.imageVisibility,
    template: {
      name: `scribe-drop-worker-${environment}-${imageDigest.slice(0, 12)}`,
      image,
      registryAuthId,
      serverless: true,
      containerDiskInGb,
      ports: [],
      volumeInGb: 0,
      environment: {
        APP_ENV: environment,
        ORCHESTRATOR_ORIGIN: orchestratorOrigin,
        ALLOWED_SOURCE_HOSTS: r2Host,
        ALLOWED_RESULT_HOSTS: r2Host,
        MAX_SOURCE_BYTES: String(maxSourceBytes),
        MAX_DURATION_SECONDS: String(maxDurationSeconds),
        HEARTBEAT_INTERVAL_SECONDS: String(heartbeatIntervalSeconds),
        MODEL_PATH: "/opt/models/large-v3-turbo",
      },
    },
    endpoint: {
      name: `scribe-drop-${environment}`,
      computeType: "GPU",
      gpuTypeIds: requireGpuTypeIds(input.gpuTypeIds, environment),
      gpuCount: 1,
      workersMin: 0,
      workersMax: 1,
      idleTimeoutSeconds,
      executionTimeoutSeconds,
      minCudaVersion: "12.8",
      scalerType: "REQUEST_COUNT",
      scalerValue: 1,
      flashBoot: false,
      networkVolumeIds: [],
    },
  };
}

export function createRunpodStagingPlan(input) {
  return createRunpodPlan(input, "staging");
}

export function createRunpodProductionPlan(input) {
  return createRunpodPlan(input, "production");
}

export function validateRunpodPlan(untrustedPlan, expectedEnvironment) {
  const plan = requireRecord(untrustedPlan, "RunPod plan");
  const planEnvironment = requireEnvironment(plan.environment);
  if (
    expectedEnvironment !== undefined &&
    planEnvironment !== requireEnvironment(expectedEnvironment)
  ) {
    throw new Error(`RunPod plan environment must be ${expectedEnvironment}`);
  }
  const template = requireRecord(plan.template, `RunPod ${planEnvironment} template`);
  const environment = requireRecord(
    template.environment,
    `RunPod ${planEnvironment} template environment`,
  );
  const endpoint = requireRecord(plan.endpoint, `RunPod ${planEnvironment} endpoint`);
  const sourceHostMatch =
    typeof environment.ALLOWED_SOURCE_HOSTS === "string"
      ? r2HostPattern.exec(environment.ALLOWED_SOURCE_HOSTS)
      : null;
  if (sourceHostMatch?.[1] === undefined) {
    throw new Error(`RunPod ${planEnvironment} plan contains an invalid R2 host`);
  }
  if (
    !Array.isArray(endpoint.gpuTypeIds) ||
    endpoint.gpuTypeIds.some((value) => typeof value !== "string")
  ) {
    throw new Error(`RunPod ${planEnvironment} plan contains invalid GPU type IDs`);
  }

  const expected = createRunpodPlan(
    {
      accountId: sourceHostMatch[1],
      gpuTypeIds: endpoint.gpuTypeIds.join(","),
      image: template.image,
      imageVisibility: plan.imageVisibility,
      orchestratorOrigin: environment.ORCHESTRATOR_ORIGIN,
      registryAuthId: template.registryAuthId === null ? undefined : template.registryAuthId,
    },
    planEnvironment,
  );
  if (!isDeepStrictEqual(plan, expected)) {
    throw new Error(`RunPod ${planEnvironment} plan does not match the fixed policy`);
  }
  return expected;
}

export function validateRunpodStagingPlan(untrustedPlan) {
  return validateRunpodPlan(untrustedPlan, "staging");
}

export function validateRunpodProductionPlan(untrustedPlan) {
  return validateRunpodPlan(untrustedPlan, "production");
}

export function createRunpodTemplateArguments(untrustedPlan) {
  const plan = validateRunpodPlan(untrustedPlan);
  const arguments_ = [
    "template",
    "create",
    "--name",
    plan.template.name,
    "--image",
    plan.template.image,
    "--container-disk-in-gb",
    String(plan.template.containerDiskInGb),
    "--env",
    JSON.stringify(plan.template.environment),
    "--serverless",
  ];
  if (plan.template.registryAuthId !== null) {
    arguments_.push("--registry-auth-id", plan.template.registryAuthId);
  }
  return arguments_;
}

export function createRunpodEndpointArguments(untrustedPlan, templateId) {
  const plan = validateRunpodPlan(untrustedPlan);
  requirePattern(templateId, resourceIdPattern, "RunPod template ID");
  return [
    "serverless",
    "create",
    "--name",
    plan.endpoint.name,
    "--template-id",
    templateId,
    "--compute-type",
    plan.endpoint.computeType,
    "--gpu-id",
    plan.endpoint.gpuTypeIds[0],
    "--gpu-count",
    String(plan.endpoint.gpuCount),
    "--workers-min",
    String(plan.endpoint.workersMin),
    "--workers-max",
    String(plan.endpoint.workersMax),
    "--min-cuda-version",
    plan.endpoint.minCudaVersion,
    "--scale-by",
    "requests",
    "--scale-threshold",
    String(plan.endpoint.scalerValue),
    "--idle-timeout",
    String(plan.endpoint.idleTimeoutSeconds),
    "--flash-boot=false",
    "--execution-timeout",
    String(plan.endpoint.executionTimeoutSeconds),
  ];
}

function requireStringRecord(value, name) {
  const record = requireRecord(value, name);
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} is invalid`);
  }
  return record;
}

export function validateCreatedRunpodTemplate(untrustedTemplate, untrustedPlan) {
  const plan = validateRunpodPlan(untrustedPlan);
  const template = requireRecord(untrustedTemplate, "RunPod template response");
  const registryAuthId = template.containerRegistryAuthId ?? "";
  const expectedRegistryAuthId = plan.template.registryAuthId ?? "";
  const ports = template.ports ?? [];
  const volumeInGb = template.volumeInGb ?? 0;
  if (
    !resourceIdPattern.test(String(template.id ?? "")) ||
    template.name !== plan.template.name ||
    template.imageName !== plan.template.image ||
    template.isServerless !== true ||
    template.containerDiskInGb !== plan.template.containerDiskInGb ||
    registryAuthId !== expectedRegistryAuthId ||
    !Array.isArray(ports) ||
    ports.length !== 0 ||
    volumeInGb !== 0 ||
    !isDeepStrictEqual(
      requireStringRecord(template.env, "RunPod template response env"),
      plan.template.environment,
    )
  ) {
    throw new Error("RunPod template response does not match the fixed plan");
  }
  return template.id;
}

export function hasOnlyKnownRunpodDefaultPortDrift(untrustedTemplate, untrustedPlan) {
  const template = requireRecord(untrustedTemplate, "RunPod template response");
  const ports = template.ports;
  if (
    !Array.isArray(ports) ||
    ports.length !== 2 ||
    !ports.includes("8888/http") ||
    !ports.includes("22/tcp")
  ) {
    return false;
  }
  try {
    validateCreatedRunpodTemplate({ ...template, ports: [] }, untrustedPlan);
    return true;
  } catch {
    return false;
  }
}

export function validateCreatedRunpodEndpoint(untrustedEndpoint, untrustedPlan, templateId) {
  const plan = validateRunpodPlan(untrustedPlan);
  requirePattern(templateId, resourceIdPattern, "RunPod template ID");
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  const networkVolumeIds = endpoint.networkVolumeIds ?? [];
  const modelReferences = endpoint.modelReferences ?? [];
  const flashBootDisabled = endpoint.flashBootType === "OFF" || endpoint.flashboot === false;
  // runpodctl 2.7.2 omits placement fields from read responses and endpoint
  // bootstrap only sends the first prioritized GPU. GPU placement is therefore
  // schema-checked here and matched exactly through the official REST API.
  const computeTypeMatches =
    endpoint.computeType === undefined || endpoint.computeType === plan.endpoint.computeType;
  const gpuPlacementIsValid =
    endpoint.gpuTypeIds === undefined
      ? endpoint.gpuIds === undefined ||
        (typeof endpoint.gpuIds === "string" && endpoint.gpuIds.length > 0)
      : Array.isArray(endpoint.gpuTypeIds) &&
        endpoint.gpuTypeIds.length > 0 &&
        endpoint.gpuTypeIds.length <= 3 &&
        endpoint.gpuTypeIds.every(
          (value) => typeof value === "string" && gpuIdPattern.test(value),
        ) &&
        new Set(endpoint.gpuTypeIds).size === endpoint.gpuTypeIds.length;
  const locationsAreValid =
    endpoint.locations === undefined ||
    (typeof endpoint.locations === "string" && endpoint.locations.length > 0);
  if (
    !resourceIdPattern.test(String(endpoint.id ?? "")) ||
    endpoint.name !== plan.endpoint.name ||
    endpoint.templateId !== templateId ||
    !computeTypeMatches ||
    !gpuPlacementIsValid ||
    endpoint.gpuCount !== plan.endpoint.gpuCount ||
    (endpoint.workersMin ?? 0) !== plan.endpoint.workersMin ||
    endpoint.workersMax !== plan.endpoint.workersMax ||
    !locationsAreValid ||
    endpoint.idleTimeout !== plan.endpoint.idleTimeoutSeconds ||
    endpoint.executionTimeoutMs !== plan.endpoint.executionTimeoutSeconds * 1_000 ||
    endpoint.minCudaVersion !== plan.endpoint.minCudaVersion ||
    endpoint.scalerType !== plan.endpoint.scalerType ||
    endpoint.scalerValue !== plan.endpoint.scalerValue ||
    !flashBootDisabled ||
    (endpoint.networkVolumeId ?? "") !== "" ||
    !Array.isArray(networkVolumeIds) ||
    networkVolumeIds.length !== 0 ||
    !Array.isArray(modelReferences) ||
    modelReferences.length !== 0
  ) {
    throw new Error("RunPod endpoint response does not match the fixed plan");
  }
  return endpoint.id;
}

export function validateRunpodEndpointCapacity(untrustedEndpoint, untrustedPlan) {
  const plan = validateRunpodPlan(untrustedPlan);
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint capacity response");
  if (
    !resourceIdPattern.test(String(endpoint.id ?? "")) ||
    !Array.isArray(endpoint.gpuTypeIds) ||
    !isDeepStrictEqual(endpoint.gpuTypeIds, plan.endpoint.gpuTypeIds)
  ) {
    throw new Error("RunPod endpoint capacity does not match the fixed plan");
  }
  return {
    gpuTypeIds: [...endpoint.gpuTypeIds],
  };
}

function requireGpuInventoryEntries(untrustedInventory, gpuTypeIds) {
  if (!Array.isArray(untrustedInventory)) {
    throw new Error("RunPod GPU inventory is missing or invalid");
  }
  return gpuTypeIds.map((gpuTypeId) => {
    const matches = untrustedInventory.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry.gpuId === gpuTypeId,
    );
    if (matches.length !== 1) {
      throw new Error("RunPod GPU inventory does not uniquely contain the fixed plan");
    }
    const [entry] = matches;
    if (entry.secureCloud !== true) {
      throw new Error("RunPod GPU fallback does not offer Secure Cloud");
    }
    return entry;
  });
}

function validateGpuInventoryPolicy(untrustedInventory, gpuTypeIds) {
  requireGpuInventoryEntries(untrustedInventory, gpuTypeIds);
  return {
    configuredCount: gpuTypeIds.length,
  };
}

function validateGpuInventory(untrustedInventory, gpuTypeIds) {
  const entries = requireGpuInventoryEntries(untrustedInventory, gpuTypeIds);
  const availableCount = entries.filter((entry) => entry.available === true).length;
  if (availableCount < minimumAvailableGpuFallbacks) {
    throw new Error("RunPod GPU fallback capacity is not release-ready");
  }
  return {
    availableCount,
    configuredCount: gpuTypeIds.length,
  };
}

export function validateRunpodGpuInventoryPolicyConfiguration(
  untrustedInventory,
  untrustedGpuTypeIds,
  untrustedEnvironment,
) {
  const environment = requireEnvironment(untrustedEnvironment);
  const gpuTypeIds = requireGpuTypeIds(untrustedGpuTypeIds, environment);
  return validateGpuInventoryPolicy(untrustedInventory, gpuTypeIds);
}

export function validateRunpodGpuInventoryConfiguration(
  untrustedInventory,
  untrustedGpuTypeIds,
  untrustedEnvironment,
) {
  const environment = requireEnvironment(untrustedEnvironment);
  const gpuTypeIds = requireGpuTypeIds(untrustedGpuTypeIds, environment);
  return validateGpuInventory(untrustedInventory, gpuTypeIds);
}

export function validateRunpodGpuInventory(untrustedInventory, untrustedPlan) {
  const plan = validateRunpodPlan(untrustedPlan);
  return validateGpuInventory(untrustedInventory, plan.endpoint.gpuTypeIds);
}
