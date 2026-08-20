import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  createProductionSmokeD1Arguments,
  parseProductionSmokeObservation,
} from "./production-smoke.mjs";

const [jobId] = process.argv.slice(2);
if (jobId === undefined || process.argv.length !== 3) {
  throw new Error("Usage: verify-production-smoke <job-id>");
}
const configPath = path.resolve(".wrangler/deploy/orchestrator-production.toml");

function run(arguments_, label, stdout = "pipe") {
  const result = spawnSync("pnpm", arguments_, {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_WRITE_LOGS: "0" },
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", stdout, "pipe"],
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout;
}

try {
  const output = run(createProductionSmokeD1Arguments(jobId, configPath), "Production D1 read");
  const observation = parseProductionSmokeObservation(JSON.parse(output), jobId);
  for (const key of [observation.sourceKey, ...observation.artifactKeys, observation.manifestKey]) {
    run(
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "get",
        `recording-transcriber-production/${key}`,
        "--remote",
        "--pipe",
        "--config",
        configPath,
        "--env",
        "production",
      ],
      "Production R2 object read",
      "ignore",
    );
  }
  console.log(
    JSON.stringify({
      artifactCount: observation.artifactKeys.length,
      jobId,
      manifestPresent: true,
      notificationSent: true,
      processingMilliseconds: observation.processingMilliseconds,
      provider: "cloud_run_jobs",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production smoke verification failed");
  process.exitCode = 1;
}
