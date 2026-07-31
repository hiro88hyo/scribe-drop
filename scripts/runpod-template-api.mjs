const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const apiKeyPattern = /^\S{16,512}$/u;
const dataCenterIdPattern = /^[A-Z]{2,3}-[A-Z]{2,3}-[0-9]+$/u;
const gpuTypeIdPattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,126}[A-Za-z0-9]$/u;
const compliancePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const runpodTemplateApiOrigin = "https://rest.runpod.io";
const runpodGraphqlApiOrigin = "https://api.runpod.io";
const runpodJobApiOrigin = "https://api.runpod.ai";
const maximumReadResponseBytes = 2 * 1024 * 1024;
const readRetryDelaysMilliseconds = [1_000, 2_000];

async function cancelResponseBody(response) {
  if (
    typeof response === "object" &&
    response !== null &&
    "body" in response &&
    response.body !== null &&
    typeof response.body === "object" &&
    "cancel" in response.body &&
    typeof response.body.cancel === "function"
  ) {
    try {
      await response.body.cancel();
    } catch {
      // Response cleanup must not replace the safe API outcome classification.
    }
  }
}

function requireApiKey(value) {
  if (typeof value !== "string" || !apiKeyPattern.test(value)) {
    throw new Error("RunPod API key is missing or invalid");
  }
  return value;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function parseBoundedJsonResponse(response) {
  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.ok !== "boolean" ||
    !Number.isSafeInteger(response.status)
  ) {
    throw new Error("RunPod read returned an invalid response");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const error = new Error("RunPod read request was rejected");
    error.retryable = retryable;
    throw error;
  }
  if (typeof response.arrayBuffer !== "function") {
    throw new Error("RunPod read returned an invalid response");
  }
  const buffer = await response.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maximumReadResponseBytes) {
    throw new Error("RunPod read response is missing or invalid");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error("RunPod read response is missing or invalid");
  }
}

async function readRunpodJson(input, dependencies) {
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const sleep = dependencies.sleep ?? defaultSleep;
  const onRetry = dependencies.onRetry ?? (() => {});
  const url = new URL(input.pathname, input.origin ?? runpodTemplateApiOrigin);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, value);
  }
  let lastError;

  for (let attempt = 0; attempt <= readRetryDelaysMilliseconds.length; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method: input.method ?? "GET",
        redirect: "error",
        signal: createTimeoutSignal(15_000),
      });
      const result = await parseBoundedJsonResponse(response);
      return input.validate(result);
    } catch (error) {
      lastError = error;
      const delay = readRetryDelaysMilliseconds[attempt];
      if (
        delay === undefined ||
        (typeof error === "object" &&
          error !== null &&
          "retryable" in error &&
          error.retryable === false)
      ) {
        break;
      }
      onRetry({
        attempt: attempt + 2,
        command: input.command,
        maximumAttempts: readRetryDelaysMilliseconds.length + 1,
      });
      await sleep(delay);
    }
  }

  throw new Error(`RunPod ${input.command} failed after bounded retries`, {
    cause: lastError,
  });
}

export function listRunpodTemplates(input, dependencies = {}) {
  return readRunpodJson(
    {
      apiKey: input.apiKey,
      command: "template list",
      pathname: "/v1/templates",
      query: { includeEndpointBoundTemplates: "true" },
      validate(value) {
        if (!Array.isArray(value)) {
          throw new Error("RunPod template list is missing or invalid");
        }
        return value;
      },
    },
    dependencies,
  );
}

export function getRunpodEndpoint(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  return readRunpodJson(
    {
      apiKey: input.apiKey,
      command: "endpoint get",
      pathname: `/v1/endpoints/${encodeURIComponent(input.endpointId)}`,
      query: {
        includeTemplate: "true",
        includeWorkers: "true",
      },
      validate(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          value.id !== input.endpointId
        ) {
          throw new Error("RunPod endpoint response is missing or invalid");
        }
        return value;
      },
    },
    dependencies,
  );
}

export function getRunpodEndpointPlacement(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  return readRunpodJson(
    {
      apiKey: input.apiKey,
      body: {
        query: `query ScribeDropEndpointPlacement($id: String!) {
  myself {
    endpoint(id: $id) {
      id
      locations
      compliance
    }
  }
}`,
        variables: { id: input.endpointId },
      },
      command: "endpoint placement",
      method: "POST",
      origin: runpodGraphqlApiOrigin,
      pathname: "/graphql",
      validate(value) {
        const endpoint = value?.data?.myself?.endpoint;
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          !Array.isArray(value.errors ?? []) ||
          (value.errors ?? []).length !== 0 ||
          typeof endpoint !== "object" ||
          endpoint === null ||
          Array.isArray(endpoint) ||
          endpoint.id !== input.endpointId ||
          !Array.isArray(endpoint.compliance) ||
          endpoint.compliance.some(
            (entry) => typeof entry !== "string" || !compliancePattern.test(entry),
          ) ||
          new Set(endpoint.compliance).size !== endpoint.compliance.length
        ) {
          throw new Error("RunPod endpoint placement response is missing or invalid");
        }
        const locations =
          endpoint.locations === undefined ||
          endpoint.locations === null ||
          endpoint.locations === ""
            ? undefined
            : typeof endpoint.locations === "string"
              ? endpoint.locations.split(",").map((candidate) => candidate.trim())
              : null;
        if (
          locations === null ||
          (locations !== undefined &&
            (locations.length === 0 ||
              locations.some((entry) => !dataCenterIdPattern.test(entry)) ||
              new Set(locations).size !== locations.length))
        ) {
          throw new Error("RunPod endpoint placement response is missing or invalid");
        }
        return {
          compliance: [...endpoint.compliance],
          ...(locations === undefined ? {} : { dataCenterIds: locations }),
          id: endpoint.id,
        };
      },
    },
    dependencies,
  );
}

export async function getRunpodEndpointCapacity(input, dependencies = {}) {
  const [endpoint, placement] = await Promise.all([
    getRunpodEndpoint(input, dependencies),
    getRunpodEndpointPlacement(input, dependencies),
  ]);
  if (endpoint.id !== placement.id) {
    throw new Error("RunPod endpoint capacity response is missing or invalid");
  }
  return {
    compliance: placement.compliance,
    ...(placement.dataCenterIds === undefined ? {} : { dataCenterIds: placement.dataCenterIds }),
    gpuTypeIds: endpoint.gpuTypeIds,
    id: endpoint.id,
  };
}

function requireNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RunPod health ${name} is missing or invalid`);
  }
  return value;
}

export function getRunpodEndpointHealth(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  return readRunpodJson(
    {
      apiKey: input.apiKey,
      command: "endpoint health",
      origin: runpodJobApiOrigin,
      pathname: `/v2/${encodeURIComponent(input.endpointId)}/health`,
      validate(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          typeof value.jobs !== "object" ||
          value.jobs === null ||
          Array.isArray(value.jobs) ||
          typeof value.workers !== "object" ||
          value.workers === null ||
          Array.isArray(value.workers)
        ) {
          throw new Error("RunPod endpoint health response is missing or invalid");
        }
        return {
          jobs: {
            inProgress: requireNonnegativeInteger(value.jobs.inProgress ?? 0, "jobs in progress"),
            inQueue: requireNonnegativeInteger(value.jobs.inQueue ?? 0, "jobs in queue"),
          },
          workers: {
            idle: requireNonnegativeInteger(value.workers.idle ?? 0, "idle workers"),
            initializing: requireNonnegativeInteger(
              value.workers.initializing ?? 0,
              "initializing workers",
            ),
            ready: requireNonnegativeInteger(value.workers.ready ?? 0, "ready workers"),
            running: requireNonnegativeInteger(value.workers.running ?? 0, "running workers"),
            throttled: requireNonnegativeInteger(value.workers.throttled ?? 0, "throttled workers"),
            unhealthy: requireNonnegativeInteger(value.workers.unhealthy ?? 0, "unhealthy workers"),
          },
        };
      },
    },
    dependencies,
  );
}

export async function verifyRunpodReleaseReadiness(input, dependencies = {}) {
  await Promise.all([
    listRunpodTemplates({ apiKey: input.apiKey }, dependencies),
    getRunpodEndpointCapacity(
      {
        apiKey: input.apiKey,
        endpointId: input.endpointId,
      },
      dependencies,
    ),
  ]);
}

export async function clearRunpodTemplatePorts(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.templateId ?? ""))) {
    throw new Error("RunPod template ID is missing or invalid");
  }
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL(
    `/v1/templates/${encodeURIComponent(input.templateId)}/update`,
    runpodTemplateApiOrigin,
  );
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify({ ports: [] }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod template port update outcome is unknown");
  }
  if (typeof response !== "object" || response === null || typeof response.ok !== "boolean") {
    throw new Error("RunPod template port update returned an invalid response");
  }
  await cancelResponseBody(response);
  if (!response.ok) {
    throw new Error("RunPod template port update was rejected");
  }
}

export async function setRunpodEndpointWorkersMax(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  if (!Number.isSafeInteger(input.workersMax) || input.workersMax < 0 || input.workersMax > 100) {
    throw new Error("RunPod endpoint worker maximum is missing or invalid");
  }
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(input.endpointId)}`,
    runpodTemplateApiOrigin,
  );
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify({ workersMax: input.workersMax }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod endpoint worker update outcome is unknown");
  }
  if (typeof response !== "object" || response === null || typeof response.ok !== "boolean") {
    throw new Error("RunPod endpoint worker update returned an invalid response");
  }
  await cancelResponseBody(response);
  if (!response.ok) {
    throw new Error("RunPod endpoint worker update was rejected");
  }
}

export async function setRunpodEndpointWorkersMin(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  if (!Number.isSafeInteger(input.workersMin) || input.workersMin < 0 || input.workersMin > 100) {
    throw new Error("RunPod endpoint worker minimum is missing or invalid");
  }
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(input.endpointId)}`,
    runpodTemplateApiOrigin,
  );
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify({ workersMin: input.workersMin }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod endpoint active worker update outcome is unknown");
  }
  if (typeof response !== "object" || response === null || typeof response.ok !== "boolean") {
    throw new Error("RunPod endpoint active worker update returned an invalid response");
  }
  await cancelResponseBody(response);
  if (!response.ok) {
    throw new Error("RunPod endpoint active worker update was rejected");
  }
}

function validateEndpointDataCenters(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !dataCenterIdPattern.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("RunPod endpoint data centers are missing or invalid");
  }
  return [...value];
}

function validateEndpointGpuTypes(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3 ||
    value.some((entry) => typeof entry !== "string" || !gpuTypeIdPattern.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("RunPod endpoint GPU types are missing or invalid");
  }
  return [...value];
}

function validateGraphqlEndpointConfiguration(untrusted, endpointId) {
  const endpoint = untrusted;
  const isNonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  const isOptionalSafeString = (value) =>
    value === undefined ||
    value === null ||
    (typeof value === "string" && /^[A-Za-z0-9_.-]*$/u.test(value));
  const gpuPoolIds =
    typeof endpoint?.gpuIds === "string"
      ? endpoint.gpuIds.split(",").map((entry) => entry.trim())
      : [];
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    Array.isArray(endpoint) ||
    endpoint.id !== endpointId ||
    typeof endpoint.name !== "string" ||
    endpoint.name.length === 0 ||
    endpoint.name.length > 191 ||
    !resourceIdPattern.test(String(endpoint.templateId ?? "")) ||
    endpoint.computeType !== "GPU" ||
    gpuPoolIds.length === 0 ||
    gpuPoolIds.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(entry)) ||
    new Set(gpuPoolIds).size !== gpuPoolIds.length ||
    !isPositiveInteger(endpoint.gpuCount) ||
    !Array.isArray(endpoint.instanceIds) ||
    endpoint.instanceIds.some((entry) => !resourceIdPattern.test(String(entry))) ||
    !isNonnegativeInteger(endpoint.workersMin) ||
    !isNonnegativeInteger(endpoint.workersMax) ||
    endpoint.workersMin > endpoint.workersMax ||
    !isPositiveInteger(endpoint.idleTimeout) ||
    typeof endpoint.scalerType !== "string" ||
    !/^[A-Z][A-Z_]{1,63}$/u.test(endpoint.scalerType) ||
    !isPositiveInteger(endpoint.scalerValue) ||
    !isPositiveInteger(endpoint.executionTimeoutMs) ||
    !isOptionalSafeString(endpoint.minCudaVersion) ||
    !isOptionalSafeString(endpoint.flashBootType) ||
    !Array.isArray(endpoint.modelReferences) ||
    endpoint.modelReferences.some((entry) => !resourceIdPattern.test(String(entry))) ||
    !Array.isArray(endpoint.compliance) ||
    endpoint.compliance.some(
      (entry) => typeof entry !== "string" || !compliancePattern.test(entry),
    ) ||
    new Set(endpoint.compliance).size !== endpoint.compliance.length ||
    !Array.isArray(endpoint.networkVolumeIds) ||
    endpoint.networkVolumeIds.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        !resourceIdPattern.test(String(entry.networkVolumeId ?? "")),
    ) ||
    !(
      endpoint.networkVolumeId === undefined ||
      endpoint.networkVolumeId === null ||
      endpoint.networkVolumeId === "" ||
      resourceIdPattern.test(String(endpoint.networkVolumeId))
    )
  ) {
    throw new Error("RunPod endpoint GraphQL configuration is missing or invalid");
  }
  return {
    compliance: [...endpoint.compliance],
    computeType: endpoint.computeType,
    executionTimeoutMs: endpoint.executionTimeoutMs,
    flashBootType: endpoint.flashBootType,
    gpuCount: endpoint.gpuCount,
    gpuIds: gpuPoolIds.join(","),
    id: endpoint.id,
    idleTimeout: endpoint.idleTimeout,
    instanceIds: [...endpoint.instanceIds],
    minCudaVersion: endpoint.minCudaVersion,
    modelReferences: [...endpoint.modelReferences],
    name: endpoint.name,
    networkVolumeId: endpoint.networkVolumeId,
    networkVolumeIds: endpoint.networkVolumeIds.map((entry) => ({
      networkVolumeId: entry.networkVolumeId,
    })),
    scalerType: endpoint.scalerType,
    scalerValue: endpoint.scalerValue,
    templateId: endpoint.templateId,
    workersMax: endpoint.workersMax,
    workersMin: endpoint.workersMin,
  };
}

async function getRunpodEndpointGraphqlConfiguration(input, dependencies) {
  return readRunpodJson(
    {
      apiKey: input.apiKey,
      body: {
        query: `query ScribeDropEndpointConfiguration($id: String!) {
  myself {
    endpoint(id: $id) {
      id
      name
      templateId
      gpuIds
      gpuCount
      instanceIds
      workersMin
      workersMax
      locations
      networkVolumeId
      networkVolumeIds {
        networkVolumeId
        dataCenterId
      }
      idleTimeout
      scalerType
      scalerValue
      executionTimeoutMs
      minCudaVersion
      flashBootType
      modelReferences
      compliance
      computeType
    }
  }
}`,
        variables: { id: input.endpointId },
      },
      command: "endpoint GraphQL configuration",
      method: "POST",
      origin: runpodGraphqlApiOrigin,
      pathname: "/graphql",
      validate(value) {
        if (!Array.isArray(value?.errors ?? []) || (value.errors ?? []).length !== 0) {
          throw new Error("RunPod endpoint GraphQL configuration is missing or invalid");
        }
        return validateGraphqlEndpointConfiguration(
          value?.data?.myself?.endpoint,
          input.endpointId,
        );
      },
    },
    dependencies,
  );
}

export async function setRunpodEndpointDataCenters(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  const dataCenterIds = validateEndpointDataCenters(input.dataCenterIds);
  const apiKey = requireApiKey(input.apiKey);
  const configuration = validateGraphqlEndpointConfiguration(
    dependencies.getEndpointConfiguration === undefined
      ? await getRunpodEndpointGraphqlConfiguration(
          { apiKey, endpointId: input.endpointId },
          dependencies,
        )
      : await dependencies.getEndpointConfiguration({
          apiKey,
          endpointId: input.endpointId,
        }),
    input.endpointId,
  );
  if (configuration.compliance.length !== 0) {
    throw new Error(
      "RunPod endpoint with a compliance filter cannot change data centers automatically",
    );
  }
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL("/graphql", runpodGraphqlApiOrigin);
  const endpointInput = {
    executionTimeoutMs: configuration.executionTimeoutMs,
    ...(typeof configuration.flashBootType === "string" && configuration.flashBootType.length > 0
      ? { flashBootType: configuration.flashBootType }
      : {}),
    gpuCount: configuration.gpuCount,
    gpuIds: configuration.gpuIds,
    id: configuration.id,
    idleTimeout: configuration.idleTimeout,
    instanceIds: configuration.instanceIds,
    locations: dataCenterIds.join(","),
    ...(typeof configuration.minCudaVersion === "string" && configuration.minCudaVersion.length > 0
      ? { minCudaVersion: configuration.minCudaVersion }
      : {}),
    modelReferences: configuration.modelReferences,
    name: configuration.name,
    ...(typeof configuration.networkVolumeId === "string" &&
    configuration.networkVolumeId.length > 0
      ? { networkVolumeId: configuration.networkVolumeId }
      : {}),
    networkVolumeIds: configuration.networkVolumeIds,
    scalerType: configuration.scalerType,
    scalerValue: configuration.scalerValue,
    templateId: configuration.templateId,
    workersMax: configuration.workersMax,
    workersMin: configuration.workersMin,
  };
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify({
        query: `mutation ScribeDropSaveEndpointLocations($input: EndpointInput!) {
  saveEndpoint(input: $input) {
    id
    locations
  }
}`,
        variables: { input: endpointInput },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod endpoint data-center update outcome is unknown");
  }
  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.ok !== "boolean" ||
    typeof response.arrayBuffer !== "function"
  ) {
    throw new Error("RunPod endpoint data-center update returned an invalid response");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error("RunPod endpoint data-center update was rejected");
  }
  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    throw new Error("RunPod endpoint data-center update outcome is unknown");
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maximumReadResponseBytes) {
    throw new Error("RunPod endpoint data-center update returned an invalid response");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error("RunPod endpoint data-center update returned an invalid response");
  }
  if (
    !Array.isArray(value?.errors ?? []) ||
    (value.errors ?? []).length !== 0 ||
    value?.data?.saveEndpoint?.id !== input.endpointId
  ) {
    throw new Error("RunPod endpoint data-center update was rejected");
  }
}

export async function setRunpodEndpointGpuTypes(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  const gpuTypeIds = validateEndpointGpuTypes(input.gpuTypeIds);
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(input.endpointId)}`,
    runpodTemplateApiOrigin,
  );
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify({ gpuTypeIds }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod endpoint GPU update outcome is unknown");
  }
  if (typeof response !== "object" || response === null || typeof response.ok !== "boolean") {
    throw new Error("RunPod endpoint GPU update returned an invalid response");
  }
  await cancelResponseBody(response);
  if (!response.ok) {
    throw new Error("RunPod endpoint GPU update was rejected");
  }
}
