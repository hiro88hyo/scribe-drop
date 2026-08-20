import { spawnSync } from "node:child_process";
import process from "node:process";

const query = `
  SELECT COUNT(*) AS active_count
  FROM job_attempts
  WHERE provider_kind = 'runpod_serverless'
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED');
`;

function readActiveCount() {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "SCRIBE_DROP_DB",
      "--remote",
      "--config",
      ".wrangler/deploy/orchestrator-production.toml",
      "--env",
      "production",
      "--command",
      query,
      "--json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_WRITE_LOGS: "0" },
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Production RunPod drain read failed");
  }
  const parsed = JSON.parse(result.stdout);
  const count = parsed?.[0]?.results?.[0]?.active_count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Production RunPod drain read is invalid");
  }
  return count;
}

try {
  if (process.argv.length !== 2) {
    throw new Error("Production provider drain verifier takes no arguments");
  }
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const activeCount = readActiveCount();
    if (activeCount === 0) {
      console.log(JSON.stringify({ activeRunpodAttempts: 0, pendingRunpodAttempts: "preserved" }));
      process.exit(0);
    }
    if (attempt < 60) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Production RunPod attempts did not drain within five minutes");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production provider drain failed");
  process.exitCode = 1;
}
