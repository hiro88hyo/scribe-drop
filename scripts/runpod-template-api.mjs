const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const apiKeyPattern = /^\S{16,512}$/u;
const runpodTemplateApiOrigin = "https://rest.runpod.io";

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

export async function clearRunpodTemplatePorts(input, dependencies = {}) {
  if (!resourceIdPattern.test(String(input.templateId ?? ""))) {
    throw new Error("RunPod template ID is missing or invalid");
  }
  if (!apiKeyPattern.test(String(input.apiKey ?? ""))) {
    throw new Error("RunPod API key is missing or invalid");
  }
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
        Authorization: `Bearer ${input.apiKey}`,
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
