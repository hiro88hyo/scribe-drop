import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  renderOrchestratorProductionConfig,
  renderR2CorsProductionConfig,
  renderR2LifecycleProductionConfig,
  renderWebProductionConfig,
} from "./cloudflare-environment-config.mjs";
import { verifyReleaseCandidate } from "./release-candidate.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const orchestratorOutputDirectory = path.join(repositoryRoot, ".wrangler", "deploy");
const r2CorsOutput = path.join(orchestratorOutputDirectory, "r2-cors-production.json");
const r2LifecycleOutput = path.join(orchestratorOutputDirectory, "r2-lifecycle-production.json");
const webOutputDirectory = path.join(repositoryRoot, "apps", "web", ".wrangler", "deploy");
const webConfigRedirect = path.join(webOutputDirectory, "config.json");
const webConfigFilename = "wrangler-production.toml";
const webFunctionsLink = path.join(webOutputDirectory, "functions");
const webFunctionsTarget = "../../functions";
const target = process.argv[2];
const allowedTargets = new Set(["all", "orchestrator", "r2-cors", "r2-lifecycle", "web"]);
if (target === undefined || !allowedTargets.has(target)) {
  throw new Error("Expected config target: all, orchestrator, r2-cors, r2-lifecycle, or web");
}
const requiresOrchestratorPolicy = target === "all" || target === "orchestrator";
const candidateDirectory = process.env.RELEASE_CANDIDATE_DIRECTORY;
const runpodWorkerImage = requiresOrchestratorPolicy
  ? candidateDirectory === undefined
    ? process.env.SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE
    : verifyReleaseCandidate({
        candidateDirectory: path.resolve(candidateDirectory),
        expectedCommitSha: process.env.EXPECTED_COMMIT_SHA,
        expectedReleaseVersion: process.env.EXPECTED_RELEASE_VERSION,
      }).runpodWorker.image
  : undefined;
const identifiers = {
  acceptanceFault: process.env.SCRIBE_DROP_STAGING_ACCEPTANCE_FAULT,
  acceptanceFaultExpiresAt: process.env.SCRIBE_DROP_STAGING_ACCEPTANCE_FAULT_EXPIRES_AT,
  acceptanceFaultIssuedAt: process.env.SCRIBE_DROP_STAGING_ACCEPTANCE_FAULT_ISSUED_AT,
  acceptanceFaultJobId: process.env.SCRIBE_DROP_STAGING_ACCEPTANCE_FAULT_JOB_ID,
  accessAudience: process.env.SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE,
  accessTeamDomain: process.env.SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  auditRetentionDays: process.env.AUDIT_RETENTION_DAYS,
  candidateMigrationsDirectory: process.env.SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR,
  d1DatabaseId: process.env.SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID,
  gpuExecutionPolicy: process.env.SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY,
  multipartRetentionHours: process.env.MULTIPART_RETENTION_HOURS,
  orchestratorOrigin: process.env.SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN,
  resultRetentionDays: process.env.RESULT_RETENTION_DAYS,
  runpodAllowedGpuTypeIds: process.env.SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS,
  runpodWorkerImage,
  sourceRetentionDays: process.env.SOURCE_RETENTION_DAYS,
  webOrigin: process.env.SCRIBE_DROP_PRODUCTION_WEB_ORIGIN,
};

const configs = [
  {
    output: path.join(orchestratorOutputDirectory, "orchestrator-production.toml"),
    render: renderOrchestratorProductionConfig,
    target: "orchestrator",
    template: path.join(repositoryRoot, "apps", "orchestrator", "wrangler.toml"),
  },
  {
    output: r2LifecycleOutput,
    render: renderR2LifecycleProductionConfig,
    target: "r2-lifecycle",
    template: path.join(repositoryRoot, "infra", "cloudflare", "r2-lifecycle.production.json"),
  },
  {
    output: r2CorsOutput,
    render: renderR2CorsProductionConfig,
    target: "r2-cors",
    template: path.join(repositoryRoot, "infra", "cloudflare", "r2-cors.production.json"),
  },
  {
    output: path.join(webOutputDirectory, webConfigFilename),
    render: renderWebProductionConfig,
    target: "web",
    template: path.join(repositoryRoot, "apps", "web", "wrangler.production.toml"),
  },
];

try {
  const selectedConfigs = configs.filter((config) => target === "all" || config.target === target);
  const selectedDirectories = new Set(selectedConfigs.map((config) => path.dirname(config.output)));
  for (const outputDirectory of selectedDirectories) {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    chmodSync(outputDirectory, 0o700);
  }

  for (const config of selectedConfigs) {
    const rendered = config.render(readFileSync(config.template, "utf8"), identifiers);
    writeFileSync(config.output, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(config.output, 0o600);
  }

  if (target === "all" || target === "web") {
    writeFileSync(
      webConfigRedirect,
      `${JSON.stringify({ configPath: webConfigFilename }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(webConfigRedirect, 0o600);

    try {
      const linkStats = lstatSync(webFunctionsLink);
      if (!linkStats.isSymbolicLink() || readlinkSync(webFunctionsLink) !== webFunctionsTarget) {
        throw new Error("web production functions link exists with an unexpected target");
      }
      unlinkSync(webFunctionsLink);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  console.log(`Generated ignored Cloudflare production config: ${target}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to render production configs");
  process.exitCode = 1;
}
