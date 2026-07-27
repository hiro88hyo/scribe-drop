import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createRunpodProductionPlan,
  createRunpodStagingPlan,
} from "./runpod-environment-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(repositoryRoot, ".runpod", "deploy");
const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  throw new Error("Expected RunPod environment: staging or production");
}
const prefix = `SCRIBE_DROP_${environment.toUpperCase()}`;
const output = path.join(outputDirectory, `${environment}-plan.json`);

try {
  const createPlan =
    environment === "staging" ? createRunpodStagingPlan : createRunpodProductionPlan;
  const plan = createPlan({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    dataCenterIds: process.env[`${prefix}_RUNPOD_DATACENTER_IDS`],
    gpuId: process.env[`${prefix}_RUNPOD_GPU_ID`],
    image: process.env[`${prefix}_RUNPOD_IMAGE`],
    imageVisibility: process.env[`${prefix}_RUNPOD_IMAGE_VISIBILITY`],
    orchestratorOrigin: process.env[`${prefix}_ORCHESTRATOR_ORIGIN`],
    registryAuthId: process.env[`${prefix}_RUNPOD_REGISTRY_AUTH_ID`],
  });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(output, 0o600);
  console.log(`Generated ignored RunPod ${environment} plan.`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : `Failed to render RunPod ${environment} plan`,
  );
  process.exitCode = 1;
}
