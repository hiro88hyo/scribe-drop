import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readStagingFailureEvidenceFile } from "./staging-failure-notification.mjs";
import {
  readRemoteStagingCompletionObservation,
  waitForStagingCompletionNotification,
} from "./staging-completion-notification.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [evidencePath] = process.argv.slice(2);

try {
  if (evidencePath === undefined || process.argv.length !== 3 || !path.isAbsolute(evidencePath)) {
    throw new Error("Usage: verify-staging-completion-notification <absolute-evidence-path>");
  }
  const cloudflareApiToken = process.env["CLOUDFLARE_API_TOKEN"];
  if (cloudflareApiToken === undefined || cloudflareApiToken.length < 20) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }
  const evidence = readStagingFailureEvidenceFile(evidencePath);
  const observation = await waitForStagingCompletionNotification(() =>
    Promise.resolve(
      readRemoteStagingCompletionObservation({
        cloudflareApiToken,
        configPath: path.join(repositoryRoot, ".wrangler/deploy/orchestrator-staging.toml"),
        jobId: evidence.jobId,
        repositoryRoot,
      }),
    ),
  );
  console.log(
    JSON.stringify({
      jobId: evidence.jobId,
      notificationSent: true,
      processingMilliseconds: observation.processingMilliseconds,
      provider: observation.providerKind,
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Staging completion notification verification failed",
  );
  process.exitCode = 1;
}
