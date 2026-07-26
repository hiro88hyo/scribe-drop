import { isDeepStrictEqual } from "node:util";

const accountIdPattern = /^[0-9a-f]{32}$/u;
const dataCenterIdPattern = /^[A-Z]{2,3}-[A-Z]{2,3}-[0-9]+$/u;
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

function requireDataCenterIds(value) {
  if (typeof value !== "string") {
    throw new Error("SCRIBE_DROP_STAGING_RUNPOD_DATACENTER_IDS is missing or invalid");
  }
  const values = value.split(",").map((candidate) => candidate.trim());
  if (
    values.length === 0 ||
    values.some((candidate) => !dataCenterIdPattern.test(candidate)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("SCRIBE_DROP_STAGING_RUNPOD_DATACENTER_IDS is missing or invalid");
  }
  return values;
}

function requireRegistryConfiguration(input) {
  if (input.imageVisibility !== "private" && input.imageVisibility !== "public") {
    throw new Error("SCRIBE_DROP_STAGING_RUNPOD_IMAGE_VISIBILITY must be private or public");
  }

  if (input.imageVisibility === "private") {
    return requirePattern(
      input.registryAuthId,
      registryAuthIdPattern,
      "SCRIBE_DROP_STAGING_RUNPOD_REGISTRY_AUTH_ID",
    );
  }
  if (input.registryAuthId !== undefined && input.registryAuthId !== "") {
    throw new Error("public RunPod image must not use registry authentication");
  }
  return null;
}

export function createRunpodStagingPlan(input) {
  const accountId = requirePattern(input.accountId, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID");
  const image = requirePattern(input.image, imagePattern, "SCRIBE_DROP_STAGING_RUNPOD_IMAGE");
  const imageDigest = image.slice(image.indexOf("sha256:") + "sha256:".length);
  const orchestratorOrigin = requireExactHttpsOrigin(
    input.orchestratorOrigin,
    "SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN",
  );
  const registryAuthId = requireRegistryConfiguration(input);
  const r2Host = `${accountId}.r2.cloudflarestorage.com`;

  return {
    schemaVersion: 1,
    environment: "staging",
    imageVisibility: input.imageVisibility,
    template: {
      name: `scribe-drop-worker-staging-${imageDigest.slice(0, 12)}`,
      image,
      registryAuthId,
      serverless: true,
      containerDiskInGb,
      ports: [],
      volumeInGb: 0,
      environment: {
        APP_ENV: "staging",
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
      name: "scribe-drop-staging",
      computeType: "GPU",
      gpuId: requirePattern(input.gpuId, gpuIdPattern, "SCRIBE_DROP_STAGING_RUNPOD_GPU_ID"),
      gpuCount: 1,
      dataCenterIds: requireDataCenterIds(input.dataCenterIds),
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

export function validateRunpodStagingPlan(untrustedPlan) {
  const plan = requireRecord(untrustedPlan, "RunPod staging plan");
  const template = requireRecord(plan.template, "RunPod staging template");
  const environment = requireRecord(template.environment, "RunPod staging template environment");
  const endpoint = requireRecord(plan.endpoint, "RunPod staging endpoint");
  const sourceHostMatch =
    typeof environment.ALLOWED_SOURCE_HOSTS === "string"
      ? r2HostPattern.exec(environment.ALLOWED_SOURCE_HOSTS)
      : null;
  if (sourceHostMatch?.[1] === undefined) {
    throw new Error("RunPod staging plan contains an invalid R2 host");
  }
  if (
    !Array.isArray(endpoint.dataCenterIds) ||
    endpoint.dataCenterIds.some((value) => typeof value !== "string")
  ) {
    throw new Error("RunPod staging plan contains invalid data center IDs");
  }

  const expected = createRunpodStagingPlan({
    accountId: sourceHostMatch[1],
    dataCenterIds: endpoint.dataCenterIds.join(","),
    gpuId: endpoint.gpuId,
    image: template.image,
    imageVisibility: plan.imageVisibility,
    orchestratorOrigin: environment.ORCHESTRATOR_ORIGIN,
    registryAuthId: template.registryAuthId === null ? undefined : template.registryAuthId,
  });
  if (!isDeepStrictEqual(plan, expected)) {
    throw new Error("RunPod staging plan does not match the fixed policy");
  }
  return expected;
}

export function createRunpodTemplateArguments(untrustedPlan) {
  const plan = validateRunpodStagingPlan(untrustedPlan);
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
  const plan = validateRunpodStagingPlan(untrustedPlan);
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
    plan.endpoint.gpuId,
    "--gpu-count",
    String(plan.endpoint.gpuCount),
    "--workers-min",
    String(plan.endpoint.workersMin),
    "--workers-max",
    String(plan.endpoint.workersMax),
    "--data-center-ids",
    plan.endpoint.dataCenterIds.join(","),
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
  const plan = validateRunpodStagingPlan(untrustedPlan);
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

export function validateCreatedRunpodEndpoint(untrustedEndpoint, untrustedPlan, templateId) {
  const plan = validateRunpodStagingPlan(untrustedPlan);
  requirePattern(templateId, resourceIdPattern, "RunPod template ID");
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  const networkVolumeIds = endpoint.networkVolumeIds ?? [];
  const modelReferences = endpoint.modelReferences ?? [];
  const flashBootDisabled = endpoint.flashBootType === "OFF" || endpoint.flashboot === false;
  // runpodctl 2.7.2 omits these fields from REST read responses even though it
  // accepts and sends them during create. Validate them whenever the provider
  // reports them; the exact create arguments are covered separately.
  const computeTypeMatches =
    endpoint.computeType === undefined || endpoint.computeType === plan.endpoint.computeType;
  const gpuIdsMatch =
    endpoint.gpuIds === undefined ||
    (typeof endpoint.gpuIds === "string" && endpoint.gpuIds.length > 0);
  const locationsMatch =
    endpoint.locations === undefined ||
    endpoint.locations === plan.endpoint.dataCenterIds.join(",");
  if (
    !resourceIdPattern.test(String(endpoint.id ?? "")) ||
    endpoint.name !== plan.endpoint.name ||
    endpoint.templateId !== templateId ||
    !computeTypeMatches ||
    !gpuIdsMatch ||
    endpoint.gpuCount !== plan.endpoint.gpuCount ||
    (endpoint.workersMin ?? 0) !== plan.endpoint.workersMin ||
    endpoint.workersMax !== plan.endpoint.workersMax ||
    !locationsMatch ||
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
