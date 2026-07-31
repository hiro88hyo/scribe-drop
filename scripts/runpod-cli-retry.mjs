import { randomInt } from "node:crypto";

const READ_RETRY_DELAYS_MS = [1_000, 2_000];
const READ_RETRY_JITTER_MAX_MS = 250;

function expectedReadResponseKind(arguments_) {
  const command = arguments_.slice(0, 2).join(" ");
  if (command === "template get" || command === "serverless get") {
    return "record";
  }
  if (command === "gpu list") {
    return "array";
  }
  return undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderErrorEnvelope(value) {
  return isRecord(value) && ("error" in value || "errors" in value);
}

function matchesExpectedKind(value, expectedKind) {
  return (
    (expectedKind === "record" && isRecord(value)) ||
    (expectedKind === "array" && Array.isArray(value))
  );
}

function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runRunpodCliWithReadRetry(arguments_, runOnce, dependencies = {}) {
  const expectedKind = expectedReadResponseKind(arguments_);
  if (expectedKind === undefined) {
    return runOnce(arguments_);
  }

  const sleep = dependencies.sleep ?? defaultSleep;
  const jitter = dependencies.jitter ?? (() => randomInt(0, READ_RETRY_JITTER_MAX_MS + 1));
  const onRetry = dependencies.onRetry ?? (() => {});
  let lastError;

  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = runOnce(arguments_);
      if (!matchesExpectedKind(response, expectedKind) || isProviderErrorEnvelope(response)) {
        throw new Error("RunPod read response is missing or invalid");
      }
      return response;
    } catch (error) {
      lastError = error;
      const delay = READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        break;
      }
      const delayWithJitter = delay + jitter();
      onRetry({
        attempt: attempt + 2,
        command: arguments_.slice(0, 2).join(" "),
        delayMilliseconds: delayWithJitter,
        maximumAttempts: READ_RETRY_DELAYS_MS.length + 1,
      });
      sleep(delayWithJitter);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("RunPod read command failed after bounded retries");
}
