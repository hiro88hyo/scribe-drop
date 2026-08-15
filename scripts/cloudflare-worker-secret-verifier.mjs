const cloudRunOrchestratorSecrets = Object.freeze([
  "CLOUD_RUN_CONTROLLER_HMAC_PRIMARY",
  "CLOUD_RUN_RUNTIME_DERIVATION_SECRET",
]);

export const requiredOrchestratorSecrets = Object.freeze([
  "DISCORD_WEBHOOK_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "RUNPOD_API_KEY",
  "RUNPOD_ENDPOINT_ID",
]);

export function parseWorkerSecretNames(output) {
  if (typeof output !== "string") {
    throw new TypeError("Worker secret list output must be a string");
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Worker secret list output is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Worker secret list output must be an array");
  }

  const names = new Set();
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.name !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/u.test(entry.name) ||
      Object.hasOwn(entry, "value")
    ) {
      throw new Error("Worker secret list output contains an invalid entry");
    }
    names.add(entry.name);
  }
  return names;
}

export function verifyRequiredOrchestratorSecrets(output, environment, cloudRunMode = "disabled") {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Worker secret environment is invalid");
  }
  const activeMode = environment === "staging" ? "synthetic-shadow" : "active";
  if (cloudRunMode !== "disabled" && cloudRunMode !== activeMode) {
    throw new Error("Cloud Run runtime mode is invalid");
  }
  const names = parseWorkerSecretNames(output);
  const required =
    cloudRunMode === activeMode
      ? [...requiredOrchestratorSecrets, ...cloudRunOrchestratorSecrets]
      : requiredOrchestratorSecrets;
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required Orchestrator secrets: ${missing.join(", ")}`);
  }
  return {
    listedCount: names.size,
    requiredCount: required.length,
  };
}
