import { spawnSync } from "node:child_process";
import process from "node:process";

import { verifyGpuControllerImageInspection } from "./gpu-controller-image.mjs";

const image = "scribe-drop-gpu-controller:local";
const inspection = spawnSync("docker", ["image", "inspect", image], {
  encoding: "utf8",
  maxBuffer: 1_048_576,
});
if (
  inspection.error !== undefined ||
  inspection.signal !== null ||
  inspection.status !== 0 ||
  inspection.stdout.length > 1_048_576
) {
  throw new Error("GPU controller image inspection failed");
}
verifyGpuControllerImageInspection(JSON.parse(inspection.stdout));

const check = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--entrypoint",
    "/nodejs/bin/node",
    image,
    "dist/container-check.js",
  ],
  { encoding: "utf8", maxBuffer: 65_536 },
);
if (
  check.error !== undefined ||
  check.signal !== null ||
  check.status !== 0 ||
  check.stdout !== '{"event":"controller_container_check","outcome":"accepted"}\n'
) {
  throw new Error("GPU controller offline container check failed");
}
process.stdout.write("GPU controller image verification passed.\n");
