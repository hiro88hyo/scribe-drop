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
          typeof value.workers !== "object" ||
          value.workers === null ||
          Array.isArray(value.workers)
        ) {
          throw new Error("RunPod endpoint health response is missing or invalid");
        }
        return {
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

export async function setRunpodEndpointCapacity(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.endpointId ?? ""))) {
    throw new Error("RunPod endpoint ID is missing or invalid");
  }
  if (
    !Array.isArray(input.gpuTypeIds) ||
    input.gpuTypeIds.length === 0 ||
    input.gpuTypeIds.length > 3 ||
    input.gpuTypeIds.some((value) => typeof value !== "string" || !gpuTypeIdPattern.test(value)) ||
    new Set(input.gpuTypeIds).size !== input.gpuTypeIds.length
  ) {
    throw new Error("RunPod endpoint GPU types are missing or invalid");
  }
  if (
    !Array.isArray(input.dataCenterIds) ||
    input.dataCenterIds.length === 0 ||
    input.dataCenterIds.some(
      (value) => typeof value !== "string" || !dataCenterIdPattern.test(value),
    ) ||
    new Set(input.dataCenterIds).size !== input.dataCenterIds.length
  ) {
    throw new Error("RunPod endpoint data centers are missing or invalid");
  }
  const apiKey = requireApiKey(input.apiKey);
  const fetchImplementation = dependencies.fetchImplementation ?? globalThis.fetch;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const url = new URL(
    `/v1/endpoints/${encodeURIComponent(input.endpointId)}`,
    runpodTemplateApiOrigin,
  );
  const body = {
    dataCenterIds: input.dataCenterIds,
    gpuTypeIds: input.gpuTypeIds,
  };
  let response;
  try {
    response = await fetchImplementation(url, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
      redirect: "error",
      signal: createTimeoutSignal(60_000),
    });
  } catch {
    throw new Error("RunPod endpoint capacity update outcome is unknown");
  }
  if (typeof response !== "object" || response === null || typeof response.ok !== "boolean") {
    throw new Error("RunPod endpoint capacity update returned an invalid response");
  }
  await cancelResponseBody(response);
  if (!response.ok) {
    throw new Error("RunPod endpoint capacity update was rejected");
  }
}
