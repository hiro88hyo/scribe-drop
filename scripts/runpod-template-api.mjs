const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const apiKeyPattern = /^\S{16,512}$/u;
const runpodTemplateApiOrigin = "https://rest.runpod.io";
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
  const url = new URL(input.pathname, runpodTemplateApiOrigin);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, value);
  }
  let lastError;

  for (let attempt = 0; attempt <= readRetryDelaysMilliseconds.length; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        method: "GET",
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

export async function verifyRunpodReleaseReadiness(input, dependencies = {}) {
  await Promise.all([
    listRunpodTemplates({ apiKey: input.apiKey }, dependencies),
    getRunpodEndpoint(
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
