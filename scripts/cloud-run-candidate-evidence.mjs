import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const digestImagePattern =
  /^asia-southeast1-docker\.pkg\.dev\/scribe-drop\/(controller|worker)\/runtime@sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;

function requireCandidateImage(value, component) {
  if (typeof value !== "string") throw new Error(`${component} candidate image is invalid`);
  const match = digestImagePattern.exec(value);
  if (match?.[1] !== component) throw new Error(`${component} candidate image is invalid`);
  return value;
}

export function requireCloudRunCandidateEvidencePath(outputPath, runnerTemp) {
  const parsedRunnerTemp = path.resolve(runnerTemp);
  const parsedOutput = path.resolve(outputPath);
  if (path.dirname(parsedOutput) !== parsedRunnerTemp) {
    throw new Error("candidate evidence must be written directly below RUNNER_TEMP");
  }
  return parsedOutput;
}

export function createCloudRunCandidateEvidence({
  commit,
  controllerImage,
  runAttempt,
  runId,
  workerImage,
}) {
  if (typeof commit !== "string" || !commitPattern.test(commit)) {
    throw new Error("candidate commit is invalid");
  }
  if (
    typeof runId !== "string" ||
    typeof runAttempt !== "string" ||
    !positiveIntegerPattern.test(runId) ||
    !positiveIntegerPattern.test(runAttempt)
  ) {
    throw new Error("candidate workflow identity is invalid");
  }
  const parsedController = requireCandidateImage(controllerImage, "controller");
  const parsedWorker = requireCandidateImage(workerImage, "worker");
  if (parsedController === parsedWorker) throw new Error("candidate images must be distinct");
  return {
    commit,
    controllerImage: parsedController,
    runAttempt,
    runId,
    schemaVersion: 1,
    workerImage: parsedWorker,
  };
}

export function parseCloudRunCandidateEvidence(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("candidate evidence is invalid");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "commit",
    "controllerImage",
    "runAttempt",
    "runId",
    "schemaVersion",
    "workerImage",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || value.schemaVersion !== 1) {
    throw new Error("candidate evidence shape is invalid");
  }
  return createCloudRunCandidateEvidence(value);
}

export function writeCloudRunCandidateEvidence(outputPath, evidence) {
  writeFileSync(
    outputPath,
    `${JSON.stringify(parseCloudRunCandidateEvidence(evidence), null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

function main() {
  const [command, outputPath, controllerImage, workerImage, commit, runId, runAttempt] =
    process.argv.slice(2);
  if (command === "create") {
    if (
      outputPath === undefined ||
      controllerImage === undefined ||
      workerImage === undefined ||
      commit === undefined ||
      runId === undefined ||
      runAttempt === undefined
    ) {
      throw new Error("candidate evidence create arguments are incomplete");
    }
    const runnerTemp = process.env.RUNNER_TEMP;
    if (runnerTemp === undefined) throw new Error("RUNNER_TEMP is required");
    writeCloudRunCandidateEvidence(
      requireCloudRunCandidateEvidencePath(outputPath, runnerTemp),
      createCloudRunCandidateEvidence({
        commit,
        controllerImage,
        runAttempt,
        runId,
        workerImage,
      }),
    );
    return;
  }
  if (command === "verify" && outputPath !== undefined && process.argv.length === 4) {
    const parsed = JSON.parse(readFileSync(outputPath, "utf8"));
    parseCloudRunCandidateEvidence(parsed);
    return;
  }
  throw new Error("Usage: cloud-run-candidate-evidence <create|verify> ...");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
