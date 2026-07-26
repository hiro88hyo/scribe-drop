import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createRunpodStagingPlan } from "./runpod-staging-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(repositoryRoot, ".runpod", "deploy");
const output = path.join(outputDirectory, "staging-plan.json");

try {
  const plan = createRunpodStagingPlan({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    dataCenterIds: process.env.SCRIBE_DROP_STAGING_RUNPOD_DATACENTER_IDS,
    gpuId: process.env.SCRIBE_DROP_STAGING_RUNPOD_GPU_ID,
    image: process.env.SCRIBE_DROP_STAGING_RUNPOD_IMAGE,
    imageVisibility: process.env.SCRIBE_DROP_STAGING_RUNPOD_IMAGE_VISIBILITY,
    orchestratorOrigin: process.env.SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN,
    registryAuthId: process.env.SCRIBE_DROP_STAGING_RUNPOD_REGISTRY_AUTH_ID,
  });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(output, 0o600);
  console.log("Generated ignored RunPod staging plan.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to render RunPod staging plan");
  process.exitCode = 1;
}
