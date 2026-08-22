import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parsers as yamlParsers } from "prettier/plugins/yaml";

import { findRunnerContextBeforeSteps } from "./github-workflow-static-analysis.mjs";
import { verifyStagingWorkflowStateContract } from "./staging-workflow-state-contract.mjs";
import {
  verifyControllerBuildPackageContract,
  verifyWorkflowControllerBuildContract,
} from "./workflow-controller-build-contract.mjs";
import { findYamlMappingDuplicates } from "./yaml-mapping-duplicates.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const packageManifestPath = path.join(repositoryRoot, "package.json");
const stagingE2ePackageManifestPath = path.join(repositoryRoot, "apps", "e2e", "package.json");
const ciWorkflowPath = path.join(workflowsDirectory, "ci.yml");
const publicationWorkflowPath = path.join(workflowsDirectory, "publish-runpod-worker.yml");
const stagingWorkflowPath = path.join(workflowsDirectory, "deploy-staging-candidate.yml");
const productionWorkflowPath = path.join(workflowsDirectory, "deploy-production-candidate.yml");
const cloudRunPublicationWorkflowPath = path.join(
  workflowsDirectory,
  "publish-cloud-run-candidate.yml",
);
const dockerIgnorePath = path.join(repositoryRoot, ".dockerignore");
const gitIgnorePath = path.join(repositoryRoot, ".gitignore");
const cloudflareReadbackScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "cloudflare-readback.mjs",
);
const stagingE2ePath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "staging-tests",
  "release-candidate.spec.ts",
);
const stagingFailureE2ePath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "staging-tests",
  "failure-notification.spec.ts",
);
const stagingFailureCleanupPath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "staging-tests",
  "failure-cleanup.spec.ts",
);
const stagingReadinessTestPath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "staging-tests",
  "data-plane-readiness.spec.ts",
);
const stagingAuthPath = path.join(repositoryRoot, "apps", "e2e", "staging-auth.ts");
const stagingAccessCredentialsPath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "access-service-credentials.ts",
);
const stagingAccessCredentialsTestPath = path.join(
  repositoryRoot,
  "apps",
  "e2e",
  "tests",
  "access-service-credentials.spec.ts",
);
const accessVerifierPath = path.join(repositoryRoot, "scripts", "access-verifier.mjs");
const releaseCandidateScriptPath = path.join(repositoryRoot, "scripts", "release-candidate.mjs");
const runpodDeploymentScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "deploy-runpod-environment.mjs",
);
const runpodPromotionScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "promote-runpod-candidate.mjs",
);
const runpodPromotionLibraryPath = path.join(repositoryRoot, "scripts", "runpod-promotion.mjs");
const runpodProductionCapacityPreparationPath = path.join(
  repositoryRoot,
  "scripts",
  "prepare-runpod-production-capacity.mjs",
);
const runpodEnvironmentConfigScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "runpod-environment-config.mjs",
);
const runpodTemplateApiScriptPath = path.join(repositoryRoot, "scripts", "runpod-template-api.mjs");
const runpodReleaseReadinessScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-runpod-release-readiness.mjs",
);
const pagesPromotionScriptPath = path.join(repositoryRoot, "scripts", "pages-promotion.mjs");
const pagesUploadPermissionScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "pages-upload-permission.mjs",
);
const productionGithubControlsVerifierPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-production-github-controls.mjs",
);
const stagingGithubControlsVerifierPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-staging-github-controls.mjs",
);
const stagingBootstrapPreflightManagerPath = path.join(
  repositoryRoot,
  "scripts",
  "manage-cloud-run-staging-bootstrap-preflight.mjs",
);
const stagingPaidReadinessVerifierPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-staging-cloud-run-paid-readiness.mjs",
);
const stagingQuotaClientPath = path.join(
  repositoryRoot,
  "scripts",
  "staging-cloud-run-quota-client.mjs",
);
const createStagingAcceptancePath = path.join(
  repositoryRoot,
  "scripts",
  "create-staging-acceptance.mjs",
);
const productionCutoverEvidencePath = path.join(
  repositoryRoot,
  "scripts",
  "production-cutover-evidence.mjs",
);
const productionReleaseEvidencePath = path.join(
  repositoryRoot,
  "scripts",
  "production-release-evidence.mjs",
);
const stagingPagesSecretsScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-cloudflare-pages-secrets.mjs",
);
const promotePagesCandidateScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "promote-pages-candidate.mjs",
);
const dockerfilePath = path.join(repositoryRoot, "apps", "runpod-worker", "Dockerfile");
const modelBundlePath = path.join(
  repositoryRoot,
  "apps",
  "runpod-worker",
  "src",
  "scribe_drop_worker",
  "model_bundle.py",
);
const versionsPath = path.join(repositoryRoot, "tools", "versions.json");
const actionReferencePattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu;
const usesPattern = /^\s*uses:\s*(\S+)/gmu;
const failures = [];
let actionReferenceCount = 0;

function requireText(contents, expected, location, description) {
  if (!contents.includes(expected)) {
    failures.push(`${location}: missing fixed ${description} (${expected})`);
  }
}

function requireTextCount(contents, expected, count, location, description) {
  const actual = contents.split(expected).length - 1;
  if (actual !== count) {
    failures.push(
      `${location}: expected fixed ${description} ${count} times, found ${actual} (${expected})`,
    );
  }
}

function forbidText(contents, forbidden, location, description) {
  if (contents.includes(forbidden)) {
    failures.push(`${location}: contains forbidden ${description} (${forbidden})`);
  }
}

function requireTextOrder(contents, earlier, later, location, description) {
  const earlierIndex = contents.indexOf(earlier);
  const laterIndex = contents.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex >= laterIndex) {
    failures.push(`${location}: invalid ${description} ordering`);
  }
}

function workflowJob(contents, jobName, location) {
  const marker = `  ${jobName}:\n`;
  const start = contents.indexOf(marker);
  if (start === -1) {
    failures.push(`${location}: missing job ${jobName}`);
    return "";
  }
  const remainder = contents.slice(start + marker.length);
  const nextJob = remainder.search(/^ {2}[a-z0-9-]+:\n/mu);
  return nextJob === -1
    ? contents.slice(start)
    : contents.slice(start, start + marker.length + nextJob);
}

function workflowStep(contents, stepName, location) {
  const marker = `      - name: ${stepName}\n`;
  const start = contents.indexOf(marker);
  if (start === -1) {
    failures.push(`${location}: missing step ${stepName}`);
    return "";
  }
  const remainder = contents.slice(start + marker.length);
  const nextStep = remainder.search(/^ {6}- name: /mu);
  return nextStep === -1
    ? contents.slice(start)
    : contents.slice(start, start + marker.length + nextStep);
}

const workflowFiles = readdirSync(workflowsDirectory)
  .filter((filename) => filename.endsWith(".yml") || filename.endsWith(".yaml"))
  .sort();

if (workflowFiles.length === 0) {
  failures.push("No GitHub Actions workflow files found.");
}

for (const filename of workflowFiles) {
  const contents = readFileSync(path.join(workflowsDirectory, filename), "utf8");
  const yaml = await yamlParsers.yaml.parse(contents, { filepath: filename });
  for (const duplicate of findYamlMappingDuplicates(yaml)) {
    failures.push(
      `${filename}:${duplicate.line}: duplicate YAML key ${duplicate.key} (first at line ${duplicate.firstLine})`,
    );
  }
  for (const jobName of findRunnerContextBeforeSteps(contents)) {
    failures.push(`${filename} ${jobName}: runner context is unavailable before step evaluation`);
  }

  for (const match of contents.matchAll(usesPattern)) {
    const reference = match[1];
    if (reference === undefined) {
      continue;
    }

    actionReferenceCount += 1;
    if (!actionReferencePattern.test(reference)) {
      failures.push(`${filename}: third-party action must use a full commit SHA, got ${reference}`);
    }
  }
}

if (actionReferenceCount === 0) {
  failures.push("No GitHub Action references found.");
}

const workflowContents = workflowFiles
  .map((filename) => readFileSync(path.join(workflowsDirectory, filename), "utf8"))
  .join("\n");
const packageManifestContents = readFileSync(packageManifestPath, "utf8");
const stagingE2ePackageManifestContents = readFileSync(stagingE2ePackageManifestPath, "utf8");
const ciWorkflowContents = readFileSync(ciWorkflowPath, "utf8");
const publicationWorkflowContents = readFileSync(publicationWorkflowPath, "utf8");
const stagingWorkflowContents = readFileSync(stagingWorkflowPath, "utf8");
const productionWorkflowContents = readFileSync(productionWorkflowPath, "utf8");
const cloudRunPublicationWorkflowContents = readFileSync(cloudRunPublicationWorkflowPath, "utf8");
let stagingWorkflowStateContract;
try {
  stagingWorkflowStateContract = await verifyStagingWorkflowStateContract(stagingWorkflowContents);
} catch (error) {
  failures.push(
    `deploy-staging-candidate.yml: ${error instanceof Error ? error.message : "invalid staging workflow state contract"}`,
  );
}
let workflowControllerBuildContract;
try {
  workflowControllerBuildContract = {
    implementation: verifyControllerBuildPackageContract(packageManifestContents),
    production: await verifyWorkflowControllerBuildContract(productionWorkflowContents, {
      expectedBuilds: 2,
      workflowName: "deploy-production-candidate.yml",
    }),
    staging: await verifyWorkflowControllerBuildContract(stagingWorkflowContents, {
      expectedBuilds: 3,
      workflowName: "deploy-staging-candidate.yml",
    }),
  };
} catch (error) {
  failures.push(
    `controller workflow build: ${error instanceof Error ? error.message : "invalid dependency closure"}`,
  );
}
const dockerIgnoreContents = readFileSync(dockerIgnorePath, "utf8");
const gitIgnoreContents = readFileSync(gitIgnorePath, "utf8");
const cloudflareReadbackScriptContents = readFileSync(cloudflareReadbackScriptPath, "utf8");
const stagingE2eContents = readFileSync(stagingE2ePath, "utf8");
const stagingFailureE2eContents = readFileSync(stagingFailureE2ePath, "utf8");
const stagingFailureCleanupContents = readFileSync(stagingFailureCleanupPath, "utf8");
const stagingReadinessTestContents = readFileSync(stagingReadinessTestPath, "utf8");
const stagingAuthContents = readFileSync(stagingAuthPath, "utf8");
const stagingAccessCredentialsContents = readFileSync(stagingAccessCredentialsPath, "utf8");
const stagingAccessCredentialsTestContents = readFileSync(stagingAccessCredentialsTestPath, "utf8");
const accessVerifierContents = readFileSync(accessVerifierPath, "utf8");
const releaseCandidateScriptContents = readFileSync(releaseCandidateScriptPath, "utf8");
const runpodDeploymentScriptContents = readFileSync(runpodDeploymentScriptPath, "utf8");
const runpodPromotionScriptContents = readFileSync(runpodPromotionScriptPath, "utf8");
const runpodPromotionLibraryContents = readFileSync(runpodPromotionLibraryPath, "utf8");
const runpodProductionCapacityPreparationContents = readFileSync(
  runpodProductionCapacityPreparationPath,
  "utf8",
);
const runpodEnvironmentConfigScriptContents = readFileSync(
  runpodEnvironmentConfigScriptPath,
  "utf8",
);
const runpodTemplateApiScriptContents = readFileSync(runpodTemplateApiScriptPath, "utf8");
const runpodReleaseReadinessScriptContents = readFileSync(runpodReleaseReadinessScriptPath, "utf8");
const pagesPromotionScriptContents = readFileSync(pagesPromotionScriptPath, "utf8");
const pagesUploadPermissionScriptContents = readFileSync(pagesUploadPermissionScriptPath, "utf8");
const productionGithubControlsVerifierContents = readFileSync(
  productionGithubControlsVerifierPath,
  "utf8",
);
const stagingGithubControlsVerifierContents = readFileSync(
  stagingGithubControlsVerifierPath,
  "utf8",
);
const stagingBootstrapPreflightManagerContents = readFileSync(
  stagingBootstrapPreflightManagerPath,
  "utf8",
);
const stagingPaidReadinessVerifierContents = readFileSync(stagingPaidReadinessVerifierPath, "utf8");
const stagingQuotaClientContents = readFileSync(stagingQuotaClientPath, "utf8");
const createStagingAcceptanceContents = readFileSync(createStagingAcceptancePath, "utf8");
const productionCutoverEvidenceContents = readFileSync(productionCutoverEvidencePath, "utf8");
const productionReleaseEvidenceContents = readFileSync(productionReleaseEvidencePath, "utf8");
const stagingPagesSecretsScriptContents = readFileSync(stagingPagesSecretsScriptPath, "utf8");
const promotePagesCandidateScriptContents = readFileSync(promotePagesCandidateScriptPath, "utf8");
const dockerfileContents = readFileSync(dockerfilePath, "utf8");
const modelBundleContents = readFileSync(modelBundlePath, "utf8");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
const image = versions.runpodWorkerImage;
const publicationPreflightJob = workflowJob(
  publicationWorkflowContents,
  "preflight",
  "publish-runpod-worker.yml",
);
const cloudRunPublicationJob = workflowJob(
  cloudRunPublicationWorkflowContents,
  "publish",
  "publish-cloud-run-candidate.yml",
);
const stagingPreflightJob = workflowJob(
  stagingWorkflowContents,
  "preflight",
  "deploy-staging-candidate.yml",
);
const stagingMigrationJob = workflowJob(
  stagingWorkflowContents,
  "migrate",
  "deploy-staging-candidate.yml",
);
const stagingPagesDeploymentJob = workflowJob(
  stagingWorkflowContents,
  "deploy-pages",
  "deploy-staging-candidate.yml",
);
const stagingBackendJob = workflowJob(
  stagingWorkflowContents,
  "deploy-backend",
  "deploy-staging-candidate.yml",
);
const stagingAcceptanceJob = workflowJob(
  stagingWorkflowContents,
  "acceptance",
  "deploy-staging-candidate.yml",
);
const stagingResumeEvidenceJob = workflowJob(
  stagingWorkflowContents,
  "resume-acceptance-evidence",
  "deploy-staging-candidate.yml",
);
const stagingRecoveryJob = workflowJob(
  stagingWorkflowContents,
  "recover-acceptance",
  "deploy-staging-candidate.yml",
);
const productionCutoverJob = workflowJob(
  productionWorkflowContents,
  "cutover",
  "deploy-production-candidate.yml",
);
const productionVerificationJob = workflowJob(
  productionWorkflowContents,
  "verify-promotion",
  "deploy-production-candidate.yml",
);
const productionFinalizeJob = workflowJob(
  productionWorkflowContents,
  "finalize",
  "deploy-production-candidate.yml",
);
const stagingSecretVerificationStep = workflowStep(
  stagingPreflightJob,
  "Verify existing encrypted secrets",
  "deploy-staging-candidate.yml preflight job",
);
const stagingPagesPreflightStep = workflowStep(
  stagingPreflightJob,
  "Verify Pages deploy configuration and target",
  "deploy-staging-candidate.yml preflight job",
);
const stagingPagesPromotionStep = workflowStep(
  stagingPagesDeploymentJob,
  "Promote Pages candidate with exact read-back",
  "deploy-staging-candidate.yml deploy-pages job",
);
const stagingReadbackStep = workflowStep(
  stagingAcceptanceJob,
  "Verify candidate and live resource read-back",
  "deploy-staging-candidate.yml acceptance job",
);

for (const [filename, contents] of [
  ["publish-runpod-worker.yml", publicationWorkflowContents],
  ["deploy-staging-candidate.yml", stagingWorkflowContents],
  ["deploy-production-candidate.yml", productionWorkflowContents],
]) {
  requireText(contents, 'WRANGLER_WRITE_LOGS: "0"', filename, "disabled Wrangler local debug logs");
}

for (const [description, expected] of Object.entries({
  "manual candidate trigger": "workflow_dispatch:",
  "Cloud Run candidate workflow name": "name: Publish Cloud Run release candidate",
  "non-cancelling candidate concurrency": "cancel-in-progress: false",
  "fixed Singapore region": "CLOUD_RUN_REGION: asia-southeast1",
  "fixed Google Cloud project": "GOOGLE_CLOUD_PROJECT: scribe-drop",
  "fixed workload identity provider":
    "WORKLOAD_IDENTITY_PROVIDER: projects/601035271372/locations/global/workloadIdentityPools/scribe-drop-release/providers/github-actions",
  "staging GitHub Environment": "environment: staging",
  "OIDC token permission": "id-token: write",
  "read-only source permission": "contents: read",
  "bounded candidate timeout": "timeout-minutes: 90",
  "release branch restriction": "refs/heads/release/*)",
  "release version equality": 'if [ "${release_version}" != "${package_version}" ]; then',
  "exact commit equality": 'if [ "$(git rev-parse HEAD)" != "${GITHUB_SHA}" ]; then',
  "frozen pnpm install": "pnpm install --frozen-lockfile",
  "frozen Python install": "uv sync --project apps/runpod-worker --frozen",
  "pinned gcloud version": "version: 579.0.0",
  "pinned gcloud beta component": "install_components: beta",
  "full repository gate": "pnpm check",
  "Git history and worktree secret gate": "pnpm run secrets:check",
  "locked dependency audit": "pnpm run security:audit",
  "controller image build": "pnpm run container:build:gpu-controller",
  "controller image check": "pnpm run container:check:gpu-controller",
  "controller SBOM": "pnpm run container:sbom:gpu-controller",
  "controller vulnerability gate": "pnpm run container:scan:gpu-controller",
  "base worker image build": "pnpm run container:build:runpod",
  "Cloud Run worker image build": "pnpm run container:build:cloud-run",
  "Cloud Run worker image check": "pnpm run container:check:cloud-run",
  "Cloud Run worker SBOM": "pnpm run container:sbom:cloud-run",
  "Cloud Run worker vulnerability gate": "pnpm run container:scan:cloud-run",
  "password-stdin registry login": "--password-stdin",
  "run-scoped immutable tag":
    'candidate_tag="candidate-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
  "controller repository":
    "${CLOUD_RUN_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/controller/runtime:",
  "worker repository": "${CLOUD_RUN_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/worker/runtime:",
  "registry manifest read-back": "docker buildx imagetools inspect",
  "registry digest validation": "^sha256:[a-f0-9]{64}$",
  "candidate evidence creation": "cloud-run:candidate:evidence create",
  "candidate evidence verification": "cloud-run:candidate:evidence verify",
  "fixed attestation Note": "--note=scribe-drop-release-candidate",
  "fixed attestation Note project": "--note-project=scribe-drop",
  "fixed KMS location": "--keyversion-location=asia-southeast1",
  "fixed KMS keyring": "--keyversion-keyring=scribe-drop-release",
  "fixed KMS key": "--keyversion-key=candidate-attestor",
  "fixed KMS version": "--keyversion=1",
  "metadata-only evidence upload": "${{ runner.temp }}/cloud-run-candidate.json",
  "short-lived evidence retention": "retention-days: 7",
})) {
  requireText(
    cloudRunPublicationWorkflowContents,
    expected,
    "publish-cloud-run-candidate.yml",
    description,
  );
}
for (const [description, expected] of Object.entries({
  "fixed CPU limit": '"--cpu=1"',
  "fixed memory limit": '"--memory=512Mi"',
  "single task": '"--tasks=1"',
  "single parallelism": '"--parallelism=1"',
  "disabled retries": '"--max-retries=0"',
  "bounded task timeout": '"--task-timeout=60s"',
  "Binary Authorization enforcement": '"--binary-authorization=default"',
  "exact preflight Job cleanup": '"run", "jobs", "delete", plan.jobId',
  "cleanup convergence": "await waitForStagingZero(plan)",
})) {
  requireText(
    stagingBootstrapPreflightManagerContents,
    expected,
    "manage-cloud-run-staging-bootstrap-preflight.mjs",
    description,
  );
}
forbidText(
  stagingBootstrapPreflightManagerContents,
  '"--gpu',
  "manage-cloud-run-staging-bootstrap-preflight.mjs",
  "GPU allocation flag",
);

requireTextCount(
  cloudRunPublicationJob,
  "uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
  3,
  "publish-cloud-run-candidate.yml publish job",
  "pinned google-github-actions/auth v3.0.0",
);
requireTextCount(
  cloudRunPublicationJob,
  "service_account: sd-candidate-publisher@scribe-drop.iam.gserviceaccount.com",
  2,
  "publish-cloud-run-candidate.yml publish job",
  "isolated candidate publisher identity",
);
requireTextCount(
  cloudRunPublicationJob,
  "service_account: sd-release-signer@scribe-drop.iam.gserviceaccount.com",
  1,
  "publish-cloud-run-candidate.yml publish job",
  "isolated candidate signer identity",
);
requireTextCount(
  cloudRunPublicationJob,
  "token_format: access_token",
  3,
  "publish-cloud-run-candidate.yml publish job",
  "short-lived access tokens",
);
requireTextCount(
  cloudRunPublicationJob,
  "docker push",
  2,
  "publish-cloud-run-candidate.yml publish job",
  "one push per candidate image",
);
requireTextCount(
  cloudRunPublicationJob,
  '--artifact-url="${image}"',
  1,
  "publish-cloud-run-candidate.yml publish job",
  "two-digest attestation loop",
);
for (const [description, forbidden] of Object.entries({
  "production Environment": "environment: production",
  "floating image tag": ":latest",
  "service-account JSON key": "credentials_json:",
  "unscoped Workload Identity audience": "audience:",
  "attestation verifier escalation": "--validate",
  "Cloud Run deployment during publication": "gcloud run ",
})) {
  forbidText(
    cloudRunPublicationJob,
    forbidden,
    "publish-cloud-run-candidate.yml publish job",
    description,
  );
}
for (const [earlier, later, description] of [
  [
    "Require one versioned release commit",
    "Run complete application",
    "release identity before repository gates",
  ],
  ["Run complete application", "Authenticate publisher", "repository gates before cloud auth"],
  ["Authenticate publisher", "Build and inspect", "keyless auth before image builds"],
  ["Build and inspect", "Push each image", "image gates before publication"],
  [
    "Push each image",
    "Authenticate isolated release signer",
    "digest resolution before signer auth",
  ],
  ["Authenticate isolated release signer", "KMS-sign", "isolated signer before attestations"],
  ["KMS-sign", "Upload metadata-only", "attestations before evidence publication"],
]) {
  requireTextOrder(
    cloudRunPublicationJob,
    earlier,
    later,
    "publish-cloud-run-candidate.yml publish job",
    description,
  );
}

requireText(
  gitIgnoreContents,
  "gha-creds-*.json",
  ".gitignore",
  "GitHub auth credential exclusion",
);
requireText(
  dockerIgnoreContents,
  "**/gha-creds-*.json",
  ".dockerignore",
  "GitHub auth credential build-context exclusion",
);

if (image.uvImage.version !== versions.uv) {
  failures.push(
    `tools/versions.json: worker uv version (${image.uvImage.version}) must match project uv version (${versions.uv})`,
  );
}

requireText(
  dockerfileContents,
  `docker/dockerfile:${image.dockerfileFrontend.version}@${image.dockerfileFrontend.digest}`,
  "Dockerfile",
  "Dockerfile frontend",
);
requireText(dockerfileContents, `--platform=${image.platform}`, "Dockerfile", "container platform");
requireText(dockerfileContents, image.baseImage.name, "Dockerfile", "CUDA image name");
requireText(dockerfileContents, image.uvImage.version, "Dockerfile", "uv image version");
requireText(
  dockerfileContents,
  `ghcr.io/astral-sh/uv@${image.uvImage.digest}`,
  "Dockerfile",
  "uv image digest",
);
requireText(
  dockerfileContents,
  `nvidia/cuda@${image.baseImage.digest}`,
  "Dockerfile",
  "CUDA image digest",
);
requireText(
  dockerfileContents,
  `snapshot.ubuntu.com/ubuntu/${image.ubuntuSnapshot}/`,
  "Dockerfile",
  "Ubuntu snapshot",
);
requireText(
  dockerfileContents,
  `ca-certificates=${image.caCertificatesPackage}`,
  "Dockerfile",
  "ca-certificates package",
);
for (const packageName of [
  "dirmngr",
  "gnupg",
  "gnupg-utils",
  "gnupg2",
  "gpg",
  "gpg-agent",
  "gpgconf",
  "gpgsm",
  "gpgv",
  "keyboxd",
]) {
  requireTextCount(
    dockerfileContents,
    `${packageName}=${image.gnupgPackage}`,
    2,
    "Dockerfile",
    `${packageName} package`,
  );
}
for (const packageName of ["libssl3t64", "openssl"]) {
  requireTextCount(
    dockerfileContents,
    `${packageName}=${image.opensslPackage}`,
    2,
    "Dockerfile",
    `${packageName} package`,
  );
}
requireText(
  dockerfileContents,
  `python3.12=${image.pythonPackage}`,
  "Dockerfile",
  "Python package",
);
requireText(dockerfileContents, `ffmpeg=${image.ffmpegPackage}`, "Dockerfile", "FFmpeg package");

for (const [description, value] of Object.entries({
  "model repository": image.model.repository,
  "model revision": image.model.revision,
  "model.bin digest": image.model.modelSha256,
})) {
  requireText(dockerfileContents, value, "Dockerfile", description);
  requireText(modelBundleContents, value, "model_bundle.py", description);
}

for (const command of [
  "candidate:create --",
  "candidate:verify --",
  "candidate:pages --",
  "staging:acceptance:create --",
  "staging:acceptance:verify --",
]) {
  forbidText(
    workflowContents,
    command,
    "GitHub Actions workflows",
    "pnpm 11 argument separator passed through to script",
  );
}

requireText(
  workflowContents,
  `anchore/sbom-action@${image.syft.actionCommit}`,
  "GitHub Actions workflows",
  "Syft action commit",
);
requireText(
  workflowContents,
  `syft-version: v${image.syft.version}`,
  "GitHub Actions workflows",
  "Syft version",
);
requireText(
  workflowContents,
  `aquasecurity/trivy-action@${image.trivy.actionCommit}`,
  "GitHub Actions workflows",
  "Trivy action commit",
);
requireText(
  workflowContents,
  `version: v${image.trivy.version}`,
  "GitHub Actions workflows",
  "Trivy version",
);

for (const [description, value] of Object.entries({
  "manual publication trigger": "workflow_dispatch:",
  "release candidate workflow name": "name: Publish RunPod release candidate",
  "release candidate branch guard": "refs/heads/release/",
  "release version comparison": "Release branch and package version must match",
  "package write permission": "packages: write",
  "run-scoped bootstrap image tag":
    "candidate-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
  "password-stdin registry login": "--password-stdin",
  "immutable image reference evidence": "runpod-worker-image.txt",
  "workspace-anchored raw Orchestrator module output":
    '--outdir "${GITHUB_WORKSPACE}/candidate-build/orchestrator"',
  "environment-neutral candidate evidence": "scribe-drop-release-candidate-${{ github.sha }}",
  "candidate manifest creation": "pnpm run candidate:create",
  "candidate manifest verification": "pnpm run candidate:verify",
  "candidate application artifact creation": "pnpm run candidate:application:create",
  "candidate application artifact verification": "pnpm run candidate:application:verify",
  "run-scoped candidate application artifact":
    "scribe-drop-candidate-application-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  "candidate preflight dependency": "- preflight",
  "serialized release candidate execution": "group: release-candidate-${{ github.ref }}",
  "stale candidate cancellation": "cancel-in-progress: true",
  "staging-scoped readiness credential": "environment: staging",
  "fixed runpodctl install before readiness": "pnpm run runpodctl:install",
  "read-only readiness before costly work": "pnpm run runpod:release-readiness:staging",
  "Pages upload permission before costly work":
    "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "Pages-only staging credential":
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  "reusable Worker candidate run input": "reusable_worker_candidate_run_id:",
  "reusable source run verification": "verify-reusable-workflow-run.mjs",
  "reusable source ancestry verification": "git merge-base --is-ancestor",
  "reusable source candidate verification": "read-reusable-worker-reference.mjs",
  "reusable immutable image pull": 'docker pull "${REUSABLE_WORKER_IMAGE}"',
  "current-run Worker provenance": "create-runpod-worker-provenance.mjs",
  "current-run offline container check": "-m scribe_drop_worker.container_check",
  "current-run maximum-duration bounded container check":
    "-m scribe_drop_worker.bounded_container_check",
  "current-run Worker SBOM": "runpod-worker.spdx.json",
  "current-run Worker vulnerability scan": "runpod-worker-trivy.txt",
  "preflight before application assembly":
    "application:\n    name: Assemble candidate application artifacts\n    needs: preflight",
  "preflight before quality work":
    "quality:\n    name: Candidate quality gate\n    needs: preflight",
  "candidate application dependency": "- application",
  "candidate quality dependency": "- quality",
  "candidate browser E2E dependency": "- browser-e2e",
  "candidate security dependency": "- security",
})) {
  requireText(publicationWorkflowContents, value, "publish-runpod-worker.yml", description);
}
requireTextOrder(
  publicationPreflightJob,
  "Require the versioned release branch",
  "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "publish-runpod-worker.yml preflight job",
  "release identity before Pages upload permission",
);
requireTextOrder(
  publicationPreflightJob,
  "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "Verify reusable unchanged RunPod Worker candidate",
  "publish-runpod-worker.yml preflight job",
  "Pages upload permission before reusable candidate download",
);
requireTextOrder(
  publicationPreflightJob,
  "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "pnpm run runpodctl:install",
  "publish-runpod-worker.yml preflight job",
  "Pages upload permission before runpodctl install",
);
requireTextOrder(
  publicationPreflightJob,
  "pnpm run runpodctl:install",
  "pnpm run runpod:release-readiness:staging",
  "publish-runpod-worker.yml preflight job",
  "fixed runpodctl install before RunPod readiness",
);
requireTextOrder(
  publicationPreflightJob,
  "pnpm run runpod:release-readiness:staging",
  "Verify reusable unchanged RunPod Worker candidate",
  "publish-runpod-worker.yml preflight job",
  "RunPod capacity readiness before reusable candidate download",
);

requireTextCount(
  publicationWorkflowContents,
  "pnpm run build",
  1,
  "publish-runpod-worker.yml",
  "single candidate application build",
);
requireTextCount(
  publicationWorkflowContents,
  "docker buildx build \\",
  1,
  "publish-runpod-worker.yml",
  "single conditional RunPod Worker image build",
);
requireTextCount(
  publicationWorkflowContents,
  "pnpm run candidate:application:verify candidate-application",
  2,
  "publish-runpod-worker.yml",
  "candidate application verification before and after artifact transfer",
);
requireTextOrder(
  publicationWorkflowContents,
  "Reverify candidate application artifacts before expensive work",
  "Reclaim unused ephemeral runner toolchains",
  "publish-runpod-worker.yml",
  "application verification before expensive container work",
);
requireTextOrder(
  publicationWorkflowContents,
  "Reverify candidate application artifacts before expensive work",
  "Build fixed RunPod Worker image",
  "publish-runpod-worker.yml",
  "application verification before RunPod image build",
);
requireTextOrder(
  publicationWorkflowContents,
  "verify-reusable-workflow-run.mjs",
  'gh run download "${SOURCE_CANDIDATE_RUN_ID}"',
  "publish-runpod-worker.yml",
  "source run verification before reusable candidate download",
);
requireTextOrder(
  publicationWorkflowContents,
  "read-reusable-worker-reference.mjs",
  'docker pull "${REUSABLE_WORKER_IMAGE}"',
  "publish-runpod-worker.yml",
  "source candidate verification before immutable image pull",
);
requireTextOrder(
  publicationWorkflowContents,
  "Pull verified reusable RunPod Worker image",
  "Verify non-root offline runtime and model integrity",
  "publish-runpod-worker.yml",
  "reusable image pull before current-run container verification",
);
requireTextOrder(
  publicationWorkflowContents,
  "-m scribe_drop_worker.container_check",
  "-m scribe_drop_worker.bounded_container_check",
  "publish-runpod-worker.yml",
  "normal image integrity check before maximum-duration bounded check",
);
requireTextCount(
  publicationWorkflowContents,
  "-m scribe_drop_worker.bounded_container_check",
  1,
  "publish-runpod-worker.yml",
  "maximum-duration bounded container check",
);
requireTextOrder(
  publicationWorkflowContents,
  "-m scribe_drop_worker.bounded_container_check",
  "Generate synthetic M4A acceptance fixture",
  "publish-runpod-worker.yml",
  "maximum-duration bounded check before candidate fixture generation",
);
requireTextOrder(
  publicationWorkflowContents,
  "Scan image vulnerabilities",
  "create-runpod-worker-provenance.mjs",
  "publish-runpod-worker.yml",
  "current vulnerability scan before provenance and candidate creation",
);

requireTextCount(
  ciWorkflowContents,
  "-m scribe_drop_worker.bounded_container_check",
  1,
  "ci.yml",
  "maximum-duration bounded container check",
);
requireTextCount(
  ciWorkflowContents,
  "pnpm run trivy:install",
  1,
  "ci.yml",
  "checksummed Trivy installation",
);
requireTextOrder(
  ciWorkflowContents,
  "pnpm run trivy:install",
  "pnpm run toolchain:check",
  "ci.yml",
  "Trivy installation before toolchain verification",
);
requireTextOrder(
  ciWorkflowContents,
  "-m scribe_drop_worker.container_check",
  "-m scribe_drop_worker.bounded_container_check",
  "ci.yml",
  "normal image integrity check before maximum-duration bounded check",
);
requireTextOrder(
  ciWorkflowContents,
  "-m scribe_drop_worker.bounded_container_check",
  "Generate SPDX JSON SBOM",
  "ci.yml",
  "maximum-duration bounded check before supply-chain reports",
);

for (const [description, value] of Object.entries({
  "environment-specific publication input": "target_environment",
  "develop-only candidate publication": "refs/heads/develop",
  "production deployment in build workflow": "environment: production",
  "RunPod mutation in candidate workflow": "runpod:promote:",
  "Cloudflare mutation credential in candidate workflow": "CLOUDFLARE_API_TOKEN",
  "multipart Orchestrator upload body output": "--outfile candidate-build/orchestrator/index.js",
  "config-relative Orchestrator output": "--outdir candidate-build/orchestrator",
  "arbitrary RunPod Worker image input": "runpod_worker_image:",
  "mutable reusable Worker fallback": "continue-on-error:",
})) {
  forbidText(publicationWorkflowContents, value, "publish-runpod-worker.yml", description);
}

forbidText(
  ciWorkflowContents,
  "workflow_dispatch:",
  "ci.yml",
  "redundant manual CI dispatch before the complete candidate gate",
);

for (const [description, value] of Object.entries({
  "staging candidate workflow name": "name: Deploy release candidate to staging",
  "staging Environment isolation": "environment: staging",
  "trusted candidate run verification": ".github/workflows/publish-runpod-worker.yml",
  "candidate artifact download": "scribe-drop-release-candidate-${GITHUB_SHA}",
  "verified Pages assembly": "pnpm run candidate:pages",
  "read-only Pages deploy preflight": "wrangler pages deployment list",
  "read-only Worker route preflight": "pnpm run cloudflare:worker-route:verify:staging",
  "read-only RunPod preflight": "pnpm run runpod:preflight:staging",
  "candidate migration directory":
    "SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR: ../../release-candidate/migrations",
  "candidate-only RunPod promotion": "pnpm run runpod:promote:staging",
  "staging environment parity evidence": "pnpm run environment:policy:export staging",
  "Orchestrator no-rebuild deployment":
    'wrangler deploy "${RELEASE_CANDIDATE_DIRECTORY}/orchestrator/index.js"',
  "idempotent Pages promotion": "pnpm run cloudflare:pages:promote:staging pages-candidate",
  "live Cloudflare read-back": "pnpm run cloudflare:readback:staging",
  "real service E2E": "pnpm run test:e2e:staging",
  "Cloud Run candidate input": "cloud_run_candidate_run_id:",
  "Cloud Run candidate workflow verification": ".github/workflows/publish-cloud-run-candidate.yml",
  "Cloud Run candidate evidence verification": "cloud-run:candidate:evidence verify",
  "staging foundation preflight": "pnpm run cloud-run:foundation:read staging",
  "mutation-free exact controller preflight":
    "pnpm run cloud-run:controller:deploy preflight staging disabled",
  "mutation-free preflight input": "preflight_only:",
  "staging release input read-back": "pnpm run cloud-run:staging:inputs:verify",
  "single-dispatch candidate gate": "pnpm run staging:dispatch:verify",
  "staging deployment workload identity": "providers/github-staging-deployment",
  "staging admission pause before authorization":
    "Pause staging admission before bounded authorization",
  "disabled candidate controller before boundary proof":
    "Deploy the candidate controller with authorization disabled",
  "GPU-free candidate boundary proof": "Prove the exact candidate runtime boundary without a GPU",
  "mutation-free paid readiness": "Verify paid readiness without mutation",
  "exact-one controller authorization":
    "Authorize exact one bounded staging execution and deploy the candidate controller",
  "staging admission activation after authorization":
    "Activate staging admission and render exact acceptance configuration",
  "Cloud Run cleanup verification":
    "Verify exact-one Cloud Run cleanup and provider storage convergence",
  "controller authorization disable": "Disable staging controller authorization after cleanup",
  "post-acceptance RunPod selection restore":
    "Restore RunPod selection while preserving the Cloud Run reaper",
  "staging-only Access client ID": "CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}",
  "staging-only Access client secret":
    "CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
  "staging acceptance creation": "pnpm run staging:acceptance:create",
  "staging acceptance artifact":
    "scribe-drop-staging-acceptance-${{ inputs.candidate_commit_sha || github.sha }}",
  "automatic failed acceptance recovery": "Converge a failed staging acceptance to the safe state",
  "RunPod baseline before acceptance":
    "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: runpod_serverless_v1",
})) {
  requireText(stagingWorkflowContents, value, "deploy-staging-candidate.yml", description);
}

const absoluteCandidateDirectory =
  "RELEASE_CANDIDATE_DIRECTORY: ${{ github.workspace }}/release-candidate";
requireTextCount(
  stagingWorkflowContents,
  absoluteCandidateDirectory,
  7,
  "deploy-staging-candidate.yml",
  "workspace-absolute candidate directory",
);
requireTextCount(
  productionWorkflowContents,
  absoluteCandidateDirectory,
  3,
  "deploy-production-candidate.yml",
  "workspace-absolute candidate directory",
);
forbidText(
  stagingWorkflowContents,
  "RELEASE_CANDIDATE_DIRECTORY: release-candidate",
  "deploy-staging-candidate.yml",
  "working-directory-relative candidate directory",
);
forbidText(
  productionWorkflowContents,
  "RELEASE_CANDIDATE_DIRECTORY: release-candidate",
  "deploy-production-candidate.yml",
  "working-directory-relative candidate directory",
);
requireText(
  packageManifestContents,
  '"staging:e2e:fixture:verify": "node scripts/verify-staging-e2e-fixture.mjs"',
  "package.json",
  "real staging E2E fixture preflight",
);
requireText(
  packageManifestContents,
  '"staging:failure-notification:verify": "node scripts/verify-staging-failure-notification.mjs"',
  "package.json",
  "real staging failure notification verifier",
);
requireText(
  stagingE2ePackageManifestContents,
  '"test:staging:failure-cleanup": "playwright test --config playwright.staging.config.ts staging-tests/failure-cleanup.spec.ts"',
  "apps/e2e/package.json",
  "synthetic staging failure cleanup test",
);
requireText(
  stagingE2ePackageManifestContents,
  '"test:staging:failure-notification": "playwright test --config playwright.staging.config.ts staging-tests/failure-notification.spec.ts"',
  "apps/e2e/package.json",
  "synthetic staging failure notification test",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run staging:dispatch:verify",
  "gh run download",
  "deploy-staging-candidate.yml preflight job",
  "single-dispatch gate before candidate download",
);
requireTextCount(
  stagingWorkflowContents,
  "pnpm run staging:dispatch:verify",
  1,
  "deploy-staging-candidate.yml",
  "single staging dispatch verifier",
);
requireTextOrder(
  stagingPreflightJob,
  'pnpm run candidate:verify "${RELEASE_CANDIDATE_DIRECTORY}"',
  "pnpm run staging:e2e:fixture:verify",
  "deploy-staging-candidate.yml preflight job",
  "candidate verification before real E2E fixture preflight",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run staging:e2e:fixture:verify",
  'pnpm run candidate:pages "${RELEASE_CANDIDATE_DIRECTORY}" pages-candidate',
  "deploy-staging-candidate.yml preflight job",
  "real E2E fixture preflight before deployment assembly",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:config:staging",
  "pnpm run cloudflare:worker-route:verify:staging",
  "deploy-staging-candidate.yml preflight job",
  "rendered custom-domain configuration before Worker route capability preflight",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:worker-route:verify:staging",
  "pnpm run runpod:preflight:staging",
  "deploy-staging-candidate.yml preflight job",
  "Worker route capability verification before RunPod preflight",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run environment:policy:export staging",
  "Verify resumed live staging parity before any mutation",
  "deploy-staging-candidate.yml preflight job",
  "rendered policy before resumed live parity",
);
for (const [description, expected] of Object.entries({
  "resume-only live parity condition": "if: ${{ inputs.resume_acceptance_only }}",
  "full resumed Cloudflare read-back": "pnpm run cloudflare:readback:staging",
  "Pages credential for resumed parity":
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
})) {
  requireText(
    stagingPreflightJob,
    expected,
    "deploy-staging-candidate.yml preflight job",
    description,
  );
}

requireTextCount(
  stagingWorkflowContents,
  "--cwd apps/web",
  1,
  "deploy-staging-candidate.yml",
  "read-only Pages app-root config discovery",
);
for (const [job, expected, description] of [
  [
    stagingMigrationJob,
    "if: ${{ !inputs.preflight_only && !inputs.resume_acceptance_only }}",
    "migration rejection after a mutation-free-only preflight",
  ],
  [stagingMigrationJob, "needs: preflight", "migration dependency on preflight"],
  [stagingPagesDeploymentJob, "needs: migrate", "Pages dependency on migration"],
  [stagingBackendJob, "needs: deploy-pages", "backend dependency on exact Pages deployment"],
  [
    stagingAcceptanceJob,
    "needs: [preflight, deploy-backend]",
    "acceptance dependency on preflight and backend promotion",
  ],
  [stagingRecoveryJob, "needs: acceptance", "recovery dependency on acceptance"],
]) {
  requireText(job, expected, "deploy-staging-candidate.yml", description);
}

for (const [job, location] of [[stagingPreflightJob, "preflight job"]]) {
  for (const [description, forbidden] of Object.entries({
    "D1 mutation": "d1 migrations apply",
    "Orchestrator mutation": "wrangler deploy",
    "Pages mutation": "cloudflare:pages:promote:staging",
    "R2 mutation": "r2 bucket cors set",
    "RunPod mutation": "runpod:promote:staging",
  })) {
    forbidText(job, forbidden, `deploy-staging-candidate.yml ${location}`, description);
  }
}

for (const [description, forbidden] of Object.entries({
  "Cloud Run controller mutation": "cloud-run:controller:deploy apply",
  "D1 mutation": "d1 migrations apply",
  "Orchestrator mutation": "wrangler deploy",
  "Pages mutation": "cloudflare:pages:promote:staging",
  "paid lifecycle": "pnpm run test:e2e:staging",
  "RunPod mutation": "runpod:promote:staging",
})) {
  forbidText(
    stagingResumeEvidenceJob,
    forbidden,
    "deploy-staging-candidate.yml recovered acceptance evidence job",
    description,
  );
}
for (const [description, expected] of Object.entries({
  "explicit recovered run input": "completed_acceptance_run_id:",
  "resume input validation": "pnpm run staging:resume:inputs:verify",
  "source run verification": "pnpm run staging:acceptance:resume:verify",
  "source commit ancestry": "git merge-base --is-ancestor",
  "recovered provider evidence": "pnpm run cloud-run:acceptance:recovered",
  "current full staging read-back": "pnpm run cloudflare:readback:staging",
  "recovered acceptance creation": "Issue short-lived recovered staging acceptance",
  "recovered acceptance artifact": "Upload immutable recovered staging acceptance",
})) {
  requireText(stagingWorkflowContents, expected, "deploy-staging-candidate.yml", description);
}
requireText(
  stagingResumeEvidenceJob,
  "needs.acceptance.result == 'skipped'",
  "deploy-staging-candidate.yml recovered acceptance evidence job",
  "paid acceptance exclusion",
);
requireText(
  createStagingAcceptanceContents,
  'process.env["EXPECTED_COMMIT_SHA"]',
  "create-staging-acceptance.mjs",
  "immutable candidate commit identity",
);
forbidText(
  createStagingAcceptanceContents,
  'process.env["GITHUB_SHA"]',
  "create-staging-acceptance.mjs",
  "workflow commit substituted for candidate commit",
);
for (const [location, contents] of [
  ["production-cutover-evidence.mjs", productionCutoverEvidenceContents],
  ["production-release-evidence.mjs", productionReleaseEvidenceContents],
  ["promote-runpod-candidate.mjs", runpodPromotionScriptContents],
]) {
  requireText(contents, "EXPECTED_COMMIT_SHA", location, "immutable candidate commit identity");
  forbidText(contents, "GITHUB_SHA", location, "workflow commit substituted for candidate commit");
}

requireTextCount(
  stagingPreflightJob,
  "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
  1,
  "deploy-staging-candidate.yml preflight job",
  "final accepted Cloud Run policy used for normalized parity",
);
requireTextCount(
  stagingPreflightJob,
  "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: runpod_serverless_v1",
  1,
  "deploy-staging-candidate.yml preflight job",
  "recovered RunPod baseline used only for resumed live parity",
);

for (const [description, expected] of Object.entries({
  "Access control-plane fail-fast command":
    "pnpm run cloudflare:access:control-plane:verify:staging",
  "Pages upload permission fail-fast command":
    "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "Pages-only API token": "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  "authenticated Access fail-fast command": "pnpm run cloudflare:access:service:verify:staging",
  "Cloudflare API token for Access read-back":
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
  "staging Access client ID secret": "CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}",
  "staging Access client secret": "CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
})) {
  requireText(
    stagingPreflightJob,
    expected,
    "deploy-staging-candidate.yml preflight job",
    description,
  );
}
requireTextOrder(
  stagingPreflightJob,
  "pnpm install --frozen-lockfile",
  "pnpm run cloudflare:access:control-plane:verify:staging",
  "deploy-staging-candidate.yml preflight job",
  "dependency install before Access control-plane fail-fast",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:access:control-plane:verify:staging",
  "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "deploy-staging-candidate.yml preflight job",
  "Access control-plane verification before Pages upload permission",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:pages:upload-permission:verify:staging",
  "pnpm run cloudflare:access:service:verify:staging",
  "deploy-staging-candidate.yml preflight job",
  "Pages upload permission before data-plane authentication",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:access:service:verify:staging",
  "pnpm run runpodctl:install",
  "deploy-staging-candidate.yml preflight job",
  "authenticated Access fail-fast before RunPod CLI installation",
);
requireTextOrder(
  stagingPreflightJob,
  "pnpm run cloudflare:access:service:verify:staging",
  "gh run download",
  "deploy-staging-candidate.yml preflight job",
  "authenticated Access fail-fast before candidate download",
);
requireTextCount(
  stagingWorkflowContents,
  "SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE: ${{ vars.SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE }}",
  6,
  "deploy-staging-candidate.yml",
  "Pages Access audience in every staging job that renders or verifies Web configuration",
);

for (const [step, location] of [
  [stagingSecretVerificationStep, "encrypted secret verification step"],
  [stagingReadbackStep, "live resource read-back step"],
]) {
  requireText(
    step,
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    `deploy-staging-candidate.yml ${location}`,
    "general Cloudflare credential for non-Pages resources",
  );
  requireText(
    step,
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
    `deploy-staging-candidate.yml ${location}`,
    "dedicated Pages credential",
  );
}
for (const [step, location] of [
  [stagingPagesPreflightStep, "Pages deployment preflight step"],
  [stagingPagesPromotionStep, "Pages promotion step"],
]) {
  requireText(
    step,
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
    `deploy-staging-candidate.yml ${location}`,
    "Wrangler mapping of the dedicated Pages credential",
  );
  forbidText(
    step,
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    `deploy-staging-candidate.yml ${location}`,
    "general Cloudflare credential in a Pages-only step",
  );
}
for (const [description, expected] of Object.entries({
  "staging-specific Pages token selection": 'environment === "staging"',
  "dedicated staging Pages token": '"CLOUDFLARE_PAGES_API_TOKEN"',
  "separate Pages Wrangler credential": "runWranglerWithToken(",
  "explicit Pages read-back token": "pagesApiToken",
})) {
  requireText(cloudflareReadbackScriptContents, expected, "cloudflare-readback.mjs", description);
}
for (const [description, expected] of Object.entries({
  "dedicated staging Pages input": "process.env.CLOUDFLARE_PAGES_API_TOKEN",
  "Wrangler credential mapping": "CLOUDFLARE_API_TOKEN: apiToken",
})) {
  requireText(
    stagingPagesSecretsScriptContents,
    expected,
    "verify-cloudflare-pages-secrets.mjs",
    description,
  );
}
forbidText(
  stagingPagesSecretsScriptContents,
  "process.env.CLOUDFLARE_API_TOKEN",
  "verify-cloudflare-pages-secrets.mjs",
  "general Cloudflare credential lookup",
);

forbidText(
  stagingWorkflowContents,
  "  pages-readiness:",
  "deploy-staging-candidate.yml",
  "immediate regional custom-domain readiness job",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify candidate and live resource read-back",
  "Verify authenticated data plane, then run real staging M4A lifecycle",
  "deploy-staging-candidate.yml acceptance job",
  "live read-back before real staging E2E",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Install fixed Playwright browser before controller mutation",
  "Pause staging admission before bounded authorization",
  "deploy-staging-candidate.yml acceptance job",
  "browser installation before any controller or admission mutation",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Deploy the candidate controller with authorization disabled",
  "Prove the exact candidate runtime boundary without a GPU",
  "deploy-staging-candidate.yml acceptance job",
  "disabled candidate controller before GPU-free boundary proof",
);
requireTextOrder(
  stagingPreflightJob,
  "Validate the exact controller deployment and read-back without mutation",
  "Verify paid readiness without mutation",
  "deploy-staging-candidate.yml preflight job",
  "controller build before mutation-free paid readiness",
);
requireTextOrder(
  stagingPreflightJob,
  "Verify paid readiness without mutation",
  "Verify the real staging E2E fixture before any mutation",
  "deploy-staging-candidate.yml preflight job",
  "complete paid readiness before remaining remote preflight",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Prove the exact candidate runtime boundary without a GPU",
  "Verify post-bootstrap safety before authorization",
  "deploy-staging-candidate.yml acceptance job",
  "GPU-free boundary proof before final safety read-back",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify post-bootstrap safety before authorization",
  "Authorize exact one bounded staging execution and deploy the candidate controller",
  "deploy-staging-candidate.yml acceptance job",
  "post-bootstrap safety before authorization",
);
requireTextCount(
  stagingPreflightJob,
  "pnpm run cloud-run:staging:paid-readiness",
  1,
  "deploy-staging-candidate.yml preflight job",
  "single mutation-free paid-readiness gate",
);
for (const [description, expected] of Object.entries({
  "disabled-zero read before paid readiness": "pnpm run cloud-run:staging:safety read",
  "exact L4 quota ID": "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion",
  "exact Cloud Quotas API": "https://cloudquotas.googleapis.com/v1/projects/${PROJECT_NUMBER}",
  "fixed manifest construction": "createFixedJobManifest",
})) {
  requireText(
    description === "disabled-zero read before paid readiness"
      ? stagingPreflightJob
      : description === "fixed manifest construction"
        ? stagingPaidReadinessVerifierContents
        : stagingQuotaClientContents,
    expected,
    "deploy-staging-candidate.yml paid-readiness gate",
    description,
  );
}
forbidText(
  stagingPaidReadinessVerifierContents,
  "node:child_process",
  "verify-staging-cloud-run-paid-readiness.mjs",
  "gcloud subprocess from read-only paid readiness",
);
requireTextCount(
  stagingWorkflowContents,
  "pnpm run runpod:preflight:staging",
  2,
  "deploy-staging-candidate.yml",
  "RunPod preflight and pre-lifecycle read-back",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify authenticated data plane, then run real staging M4A lifecycle",
  "Verify completed Cloud Run processing time and notification delivery",
  "deploy-staging-candidate.yml acceptance job",
  "processing time and completion notification after real staging E2E",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify completed Cloud Run processing time and notification delivery",
  "Delete the verified staging fixture through the authenticated owner path",
  "deploy-staging-candidate.yml acceptance job",
  "completion notification verification before fixture deletion",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Delete the verified staging fixture through the authenticated owner path",
  "Verify exact-one Cloud Run cleanup and provider storage convergence",
  "deploy-staging-candidate.yml acceptance job",
  "Cloud Run cleanup read-back after verified fixture deletion",
);
requireText(
  stagingAcceptanceJob,
  'pnpm run staging:completion-notification:verify "${STAGING_FAILURE_EVIDENCE_PATH}"',
  "deploy-staging-candidate.yml acceptance job",
  "real completion notification and processing-time gate",
);
requireText(
  stagingAcceptanceJob,
  'pnpm run cloud-run:acceptance:clean staging "${CURRENT_STAGING_RUN_PATH}"',
  "deploy-staging-candidate.yml acceptance job",
  "source-run-scoped Cloud Run cleanup gate",
);
requireText(
  stagingAcceptanceJob,
  "CURRENT_STAGING_RUN_PATH=%s\\n",
  "deploy-staging-candidate.yml acceptance job",
  "current staging run identity export",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify exact-one Cloud Run cleanup and provider storage convergence",
  "Disable staging controller authorization after cleanup",
  "deploy-staging-candidate.yml acceptance job",
  "cleanup before controller authorization disable",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Pause staging admission before bounded authorization",
  "Authorize exact one bounded staging execution and deploy the candidate controller",
  "deploy-staging-candidate.yml acceptance job",
  "staging admission pause before controller authorization",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Authorize exact one bounded staging execution and deploy the candidate controller",
  "Activate staging admission and render exact acceptance configuration",
  "deploy-staging-candidate.yml acceptance job",
  "controller authorization before staging admission",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Disable staging controller authorization after cleanup",
  "Issue short-lived staging acceptance",
  "deploy-staging-candidate.yml acceptance job",
  "authorization disable before staging acceptance issuance",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Restore RunPod selection while preserving the Cloud Run reaper",
  "Verify final disabled zero state before issuing acceptance",
  "deploy-staging-candidate.yml acceptance job",
  "staging selection restore before final safety read-back",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify final disabled zero state before issuing acceptance",
  "Issue short-lived staging acceptance",
  "deploy-staging-candidate.yml acceptance job",
  "final safety read-back before acceptance issuance",
);
requireTextCount(
  stagingAcceptanceJob,
  "access_token_lifetime: 3600s",
  1,
  "deploy-staging-candidate.yml acceptance job",
  "one-hour acceptance control-plane token",
);
for (const [description, expected] of Object.entries({
  "failure-only recovery condition":
    "needs.acceptance.result == 'failure' || needs.acceptance.result == 'cancelled'",
  "fresh recovery authentication": "Re-authenticate the isolated staging deployer for recovery",
  "one-hour recovery token": "access_token_lifetime: 3600s",
  "paused RunPod recovery policy": "Pause all new GPU admission on the RunPod recovery policy",
  "bounded reaper convergence": "pnpm run cloud-run:staging:safety wait",
  "same-run authorization recovery":
    "pnpm run cloud-run:controller:deploy recover staging disabled",
  "RunPod reactivation after disable":
    "Reactivate RunPod only after Cloud Run is disabled and empty",
  "no acceptance on recovery": "Verify recovered staging safety without issuing acceptance",
  "Pages credential for full Cloudflare recovery read-back":
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  "complete Cloudflare plan reconstruction before recovery read-back":
    "pnpm run cloudflare:config:staging\n          pnpm run runpod:config:staging",
  "RunPod plan reconstruction before full recovery read-back": "pnpm run runpod:config:staging",
  "recovery convergence continues after earlier failure":
    "id: wait-convergence\n        if: ${{ always() }}\n        continue-on-error: true",
  "controller recovery requires convergence":
    "steps.wait-convergence.outcome == 'success' && steps.build-controller.outcome == 'success'",
  "RunPod recovery requires disabled controller":
    "steps.wait-convergence.outcome == 'success' && steps.disable-controller.outcome == 'success'",
  "final recovery aggregation": "FINAL_VERIFY_OUTCOME",
})) {
  requireText(
    stagingRecoveryJob,
    expected,
    "deploy-staging-candidate.yml recovery job",
    description,
  );
}
requireTextOrder(
  stagingRecoveryJob,
  "pnpm run runpod:config:staging",
  "pnpm run cloudflare:readback:staging",
  "deploy-staging-candidate.yml recovery job",
  "RunPod plan reconstruction before full recovery read-back",
);
forbidText(
  stagingAcceptanceJob,
  "arm-recovery",
  "deploy-staging-candidate.yml acceptance job",
  "fragile recovery arm output",
);
requireText(
  stagingBackendJob,
  "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: runpod_serverless_v1",
  "deploy-staging-candidate.yml deploy-backend job",
  "RunPod selection before staging acceptance",
);
forbidText(
  stagingBackendJob,
  "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
  "deploy-staging-candidate.yml deploy-backend job",
  "Cloud Run selection before paid staging acceptance",
);
forbidText(
  stagingRecoveryJob,
  "pnpm run staging:acceptance:create",
  "deploy-staging-candidate.yml recovery job",
  "acceptance issuance from a failed run",
);
requireTextOrder(
  stagingRecoveryJob,
  "Pause all new GPU admission on the RunPod recovery policy",
  "Wait for the deployed reaper and Cloud Run resources to converge",
  "deploy-staging-candidate.yml recovery job",
  "admission pause before recovery convergence",
);
requireTextOrder(
  stagingRecoveryJob,
  "Wait for the deployed reaper and Cloud Run resources to converge",
  "Disable only this failed run's staging controller authorization",
  "deploy-staging-candidate.yml recovery job",
  "resource zero before recovery disable",
);
requireTextOrder(
  stagingRecoveryJob,
  "Disable only this failed run's staging controller authorization",
  "Reactivate RunPod only after Cloud Run is disabled and empty",
  "deploy-staging-candidate.yml recovery job",
  "controller disable before RunPod reactivation",
);
for (const forbidden of [
  "pnpm run runpod:prewarm:staging",
  "pnpm run runpod:verify-worker:staging",
  "pnpm --filter @scribe-drop/e2e run test:staging:failure-notification",
]) {
  forbidText(
    stagingAcceptanceJob,
    forbidden,
    "deploy-staging-candidate.yml acceptance job",
    "extra paid staging execution path",
  );
}
requireTextCount(
  productionWorkflowContents,
  "pnpm run runpod:preflight:production",
  1,
  "deploy-production-candidate.yml",
  "pre-mutation RunPod read-back",
);

for (const [description, expected] of Object.entries({
  "fixed Cloudflare Pages API": "https://api.cloudflare.com/client/v4/accounts/",
  "production deployment query": "deployments?env=production&page=1&per_page=1",
  "Functions deployment verification": "deployment.uses_functions === true",
  "exact config hash verification": 'createHash("sha256")',
  "read-only request method": 'method: "GET"',
  "redirect rejection": 'redirect: "error"',
  "unknown mutation outcome read-back":
    "Cloudflare Pages deployment outcome is unknown and read-back did not match",
})) {
  requireText(pagesPromotionScriptContents, expected, "pages-promotion.mjs", description);
}
for (const [description, expected] of Object.entries({
  "fixed Pages upload permission endpoint": "/upload-token",
  "read-only upload capability request": 'method: "GET"',
  "redirect rejection": 'redirect: "error"',
  "bounded permission check": "AbortSignal.timeout(15_000)",
})) {
  requireText(
    pagesUploadPermissionScriptContents,
    expected,
    "pages-upload-permission.mjs",
    description,
  );
}
forbidText(
  pagesUploadPermissionScriptContents,
  "console.",
  "pages-upload-permission.mjs",
  "upload capability logging",
);
for (const [description, expected] of Object.entries({
  "workflow identity restriction": "/deploy-staging-candidate.yml@",
  "array-based Wrangler invocation": "spawnSync(",
  "no-bundle Pages deployment": '"--no-bundle"',
  "single promotion call": "promotePagesCandidate(",
})) {
  requireText(
    promotePagesCandidateScriptContents,
    expected,
    "promote-pages-candidate.mjs",
    description,
  );
}
requireTextCount(
  promotePagesCandidateScriptContents,
  '"pages",\n      "deploy"',
  1,
  "promote-pages-candidate.mjs",
  "single Pages mutation boundary",
);

for (const [description, value] of Object.entries({
  "same-origin Access credential routing": "headersForAccessRequest(",
  "exact-origin route registration": "await context.route(`${appOrigin}/**`",
  "callback origin defense": "Staging Access route received a cross-origin request",
  "complete browser request headers including cookies": "await request.allHeaders()",
  "request method forwarding for Fetch Metadata": "request.method(),",
  "redirect boundary before credential reuse": "maxRedirects: 0",
  "credential-bearing route diagnostic suppression": "Staging Access request adapter failed",
  "continued exact-origin Access route":
    "Keep the exact-origin credential route active for the full browser",
  "route drain before context close": 'await context.unrouteAll({ behavior: "wait" });',
  "setup failure route removal": 'await context.unrouteAll({ behavior: "ignoreErrors" })',
  "authenticated application navigation": "const applicationResponse = await page.goto(baseURL",
  "service-token cookie identity check": "serviceTokenCookieMatchesExpectedIdentity(",
  "staging page origin verification": "hasExpectedStagingOrigin(page.url(), baseURL)",
  "authenticated session preflight": "fetch(url,",
  "absolute readiness URL": "stagingReadinessUrl(",
  "candidate-specific readiness URL": "/api/me?candidate=",
  "bounded Pages data-plane convergence":
    "Expected the authenticated staging data plane to converge",
})) {
  requireText(stagingAuthContents, value, "staging-auth.ts", description);
}
for (const [description, value] of Object.entries({
  "exact application origin guard":
    "Access credential routing requires the exact application origin",
  "same-origin Fetch Metadata restoration": '"Sec-Fetch-Site"] = "same-origin"',
  "unsafe method restriction": "UNSAFE_METHODS.has(requestMethod.toUpperCase())",
  "exact Origin restriction": 'headerValue(requestHeaders, "Origin") === appOrigin',
})) {
  requireText(
    stagingAccessCredentialsContents,
    value,
    "access-service-credentials.ts",
    description,
  );
}
for (const [description, value] of Object.entries({
  "Fetch Metadata exact-condition regression test":
    "restores same-origin Fetch Metadata only for exact-origin unsafe requests",
  "cross-origin route rejection": "https://storage.example.test/upload",
  "existing Fetch Metadata preservation": "existingFetchMetadata",
  "safe method Fetch Metadata rejection": "safeGet",
  "credential-bearing route diagnostic regression":
    "does not propagate credential-bearing route diagnostics",
  "continued nested Access authentication regression":
    "continues both Access layer credentials after the service cookie is issued",
  "route drain regression": "drains the Access route before closing its browser context",
  "credential client ID redaction assertion":
    "expect(errorMessage).not.toContain(credentials.clientId)",
  "credential client secret redaction assertion":
    "expect(errorMessage).not.toContain(credentials.clientSecret)",
})) {
  requireText(
    stagingAccessCredentialsTestContents,
    value,
    "access-service-credentials.spec.ts",
    description,
  );
}
for (const [contents, location] of [
  [stagingAccessCredentialsContents, "access-service-credentials.ts"],
  [accessVerifierContents, "access-verifier.mjs"],
]) {
  for (const [description, value] of Object.entries({
    "outer Access client ID header": '"CF-Access-Client-Id"',
    "outer Access client secret header": '"CF-Access-Client-Secret"',
    "inner Access Authorization client ID": '"cf-access-client-id"',
    "inner Access Authorization client secret": '"cf-access-client-secret"',
  })) {
    requireText(contents, value, location, description);
  }
}
requireTextCount(
  stagingAuthContents,
  "page.goto(baseURL",
  1,
  "staging-auth.ts",
  "single authenticated application navigation",
);
requireTextOrder(
  stagingAuthContents,
  "const applicationResponse = await page.goto(baseURL",
  "hasExpectedStagingOrigin(page.url(), baseURL)",
  "staging-auth.ts",
  "authenticated navigation before exact origin validation",
);
requireTextOrder(
  stagingAuthContents,
  "hasExpectedStagingOrigin(page.url(), baseURL)",
  'cookie.name === "CF_Authorization"',
  "staging-auth.ts",
  "exact origin validation before service-principal cookie validation",
);
forbidText(
  stagingAuthContents,
  "extraHTTPHeaders:",
  "staging-auth.ts",
  "context-wide Access service credentials",
);
forbidText(
  stagingAuthContents,
  'context.route("**/*"',
  "staging-auth.ts",
  "global request interception",
);
forbidText(
  stagingAuthContents,
  "context.request.",
  "staging-auth.ts",
  "API request Access bootstrap",
);
forbidText(
  stagingAuthContents,
  "request.headers(),",
  "staging-auth.ts",
  "partial browser request headers that omit cookies",
);
forbidText(
  stagingAuthContents,
  "establishStagingAccessSession",
  "staging-auth.ts",
  "superseded manual Access redirect traversal",
);
forbidText(
  stagingAuthContents,
  'fetch("/api/me"',
  "staging-auth.ts",
  "page-relative staging readiness request",
);
requireTextOrder(
  stagingAuthContents,
  "await context.route(`${appOrigin}/**`",
  "await completeStagingBrowserAccessHandshake(",
  "staging-auth.ts",
  "same-origin interception before browser Access handshake",
);
requireTextOrder(
  stagingAuthContents,
  "await completeStagingBrowserAccessHandshake(",
  "return { context, page };",
  "staging-auth.ts",
  "continued credential route after browser Access handshake",
);
const stagingOpenPageStart = stagingAuthContents.indexOf(
  "export async function openAuthenticatedStagingPage(",
);
const stagingOpenPageEnd = stagingAuthContents.indexOf(
  "export async function closeAuthenticatedStagingContext(",
);
if (stagingOpenPageStart < 0 || stagingOpenPageEnd <= stagingOpenPageStart) {
  throw new Error("staging-auth.ts: authenticated browser lifecycle is missing");
}
const stagingOpenPageSuccessPath = stagingAuthContents.slice(
  stagingOpenPageStart,
  stagingAuthContents.indexOf("return { context, page };", stagingOpenPageStart),
);
forbidText(
  stagingOpenPageSuccessPath,
  "unrouteAll(",
  "staging-auth.ts",
  "credential route removal before the authenticated page is returned",
);
requireTextOrder(
  stagingAuthContents,
  'await context.unrouteAll({ behavior: "wait" });',
  "await context.close();",
  "staging-auth.ts",
  "route drain before browser context close",
);
for (const [contents, location] of [
  [stagingE2eContents, "release-candidate.spec.ts"],
  [stagingFailureE2eContents, "failure-notification.spec.ts"],
  [stagingFailureCleanupContents, "failure-cleanup.spec.ts"],
  [stagingReadinessTestContents, "data-plane-readiness.spec.ts"],
]) {
  requireText(
    contents,
    "closeAuthenticatedStagingContext(context)",
    location,
    "drained authenticated context cleanup",
  );
}
requireTextOrder(
  stagingAuthContents,
  "const applicationResponse = await page.goto(baseURL",
  "hasExpectedStagingOrigin(page.url(), baseURL)",
  "staging-auth.ts",
  "application navigation before final-origin verification",
);
requireTextOrder(
  stagingE2eContents,
  "waitForAuthenticatedStagingDataPlane(page, baseURL)",
  ".setInputFiles",
  "release-candidate.spec.ts",
  "data-plane readiness before media mutation",
);
for (const [description, value] of Object.entries({
  "immediate create response observation": "const createJobResponse = page.waitForResponse(",
  "successful job admission assertion": "createResponse.status(),",
  "safe request-security diagnostics": "requestSecurityObservation",
  "safe multipart diagnostics": "multipartObservations",
  "immediate upload failure observation": "uploadAccepted.or(uploadError)",
})) {
  requireText(stagingE2eContents, value, "release-candidate.spec.ts", description);
}
for (const [description, value] of Object.entries({
  "synthetic invalid media fixture": "synthetic invalid media for staging failure acceptance",
  "bounded exact FAILED observation": "waitForStagingJobFailure(page, STAGING_FAILURE_TIMEOUT_MS)",
  "mode-600 ephemeral failure evidence":
    "writeStagingFailureEvidence(evidencePath, createdJob.data.jobId)",
})) {
  requireText(stagingFailureE2eContents, value, "failure-notification.spec.ts", description);
}
requireText(
  releaseCandidateScriptContents,
  "meRouteIndex > apiFallbackIndex",
  "release-candidate.mjs",
  "static authenticated Pages route verification",
);
requireText(
  packageManifestContents,
  "pnpm build && pnpm candidate:pages-functions:verify",
  "package.json",
  "pre-candidate Pages route gate",
);
requireText(
  packageManifestContents,
  '"github:controls:verify:staging": "node scripts/verify-staging-github-controls.mjs"',
  "package.json",
  "pre-dispatch staging GitHub controls gate",
);
requireText(
  stagingGithubControlsVerifierContents,
  "environments/staging/variables?per_page=100",
  "verify-staging-github-controls.mjs",
  "live staging variable-name read-back",
);
requireText(
  stagingGithubControlsVerifierContents,
  "environments/staging/secrets?per_page=100",
  "verify-staging-github-controls.mjs",
  "live staging secret-name read-back",
);
requireText(
  packageManifestContents,
  '"github:controls:verify:production": "node scripts/verify-production-github-controls.mjs"',
  "package.json",
  "pre-dispatch production GitHub controls gate",
);
requireText(
  productionGithubControlsVerifierContents,
  "`branches/${encodeURIComponent(branch)}/protection`",
  "verify-production-github-controls.mjs",
  "live branch protection read-back",
);
requireText(
  productionGithubControlsVerifierContents,
  "branchProtections,",
  "verify-production-github-controls.mjs",
  "branch protections passed to the fail-fast validator",
);

for (const [description, value] of Object.entries({
  "staging container rebuild": "docker build",
  "staging application rebuild": "pnpm run build",
  "direct legacy staging RunPod deploy": "runpod:deploy:staging",
  "deploy-config directory as staging Pages cwd": "--cwd apps/web/.wrangler/deploy",
})) {
  forbidText(stagingWorkflowContents, value, "deploy-staging-candidate.yml", description);
}

for (const [description, value] of Object.entries({
  "production promotion workflow name": "name: Promote staging-accepted candidate to production",
  "bounded operation input": "operation:",
  "explicit immutable candidate input": "candidate_commit_sha:",
  "mutation-free production preflight input": "preflight_only:",
  "successful production preflight run input": "preflight_run_id:",
  "cutover operation": "- cutover",
  "finalize operation": "- finalize",
  "source-managed dispatch contract": "pnpm run production:dispatch:verify",
  "operation input validation": "pnpm run production:promotion:inputs:verify",
  "successful production preflight verification": "pnpm run production:preflight:verify",
  "trusted staging run verification": ".github/workflows/deploy-staging-candidate.yml",
  "trusted candidate run verification": ".github/workflows/publish-runpod-worker.yml",
  "trusted Cloud Run candidate run verification":
    ".github/workflows/publish-cloud-run-candidate.yml",
  "staging acceptance verification": "pnpm run staging:acceptance:verify",
  "candidate verification": "pnpm run candidate:verify",
  "Cloud Run candidate verification": "pnpm run cloud-run:candidate:evidence verify",
  "isolated production workload identity provider": "providers/github-production-deployment",
  "isolated production deployment service account":
    "sd-production-deployer@scribe-drop.iam.gserviceaccount.com",
  "strict production foundation read-back": "pnpm run cloud-run:foundation:read production",
  "mutation-free production controller preflight":
    "pnpm run cloud-run:controller:deploy preflight production disabled",
  "mutation-free production controller origin preflight":
    '"${CLOUD_RUN_CANDIDATE_EVIDENCE_PATH}"\n          pnpm run cloud-run:production:origin:export',
  "production Pages upload capability preflight":
    "pnpm run cloudflare:pages:upload-permission:verify:production",
  "production Worker route capability preflight":
    "pnpm run cloudflare:worker-route:verify:production",
  "dedicated production Pages token":
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  "dedicated production Pages token bound to the actual deploy":
    'CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PAGES_API_TOKEN}" \\\n            pnpm exec wrangler pages deploy',
  "read-only Pages deploy preflight": "wrangler pages deployment list",
  "read-only RunPod preflight": "pnpm run runpod:preflight:production",
  "candidate migration directory":
    "SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR: ../../release-candidate/migrations",
  "rollback-compatible production RunPod promotion": "pnpm run runpod:promote:production",
  "paused production admission": "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: paused",
  "Cloud Run production selection":
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
  "exact-one production authorization": "Verify exact-one L4 authorization and activate admission",
  "production smoke lifecycle verification": "pnpm run cloud-run:production:smoke:verify",
  "exact resumable finalize entry verification": "pnpm run production:finalize:entry:verify",
  "production finalize source-run binding": '"${CUTOVER_RUN_PATH}"',
  "finite operational authorization": "cloud-run:controller:deploy apply production operational",
  "cutover evidence": "pnpm run production:cutover:evidence",
  "release evidence": "pnpm run production:release:evidence",
  "production environment parity comparison": "pnpm run environment:policy:export production",
  "minimum production acceptance validity": 'MINIMUM_ACCEPTANCE_REMAINING_SECONDS: "1800"',
  "production no-rebuild deployment": "--no-bundle",
  "production live read-back": "pnpm run cloudflare:readback:production",
  "production Access read-back": "pnpm run cloudflare:access:verify:production",
})) {
  requireText(productionWorkflowContents, value, "deploy-production-candidate.yml", description);
}

const productionDispatchContractStep = workflowStep(
  productionVerificationJob,
  "Validate source-managed production workflow contract",
  "deploy-production-candidate.yml verification job",
);
requireText(
  productionDispatchContractStep,
  "pnpm run production:dispatch:verify",
  "deploy-production-candidate.yml verification job",
  "source-managed dispatch contract invocation",
);
if (
  productionVerificationJob.indexOf("pnpm run production:dispatch:verify") >=
  productionVerificationJob.indexOf("pnpm run production:promotion:inputs:verify")
) {
  throw new Error(
    "deploy-production-candidate.yml verification job: source contract must run before operation or remote verification",
  );
}

requireTextCount(
  productionWorkflowContents,
  "EXPECTED_COMMIT_SHA: ${{ inputs.candidate_commit_sha }}",
  3,
  "deploy-production-candidate.yml",
  "candidate identity in every production job",
);
requireTextCount(
  productionWorkflowContents,
  'pnpm exec wrangler pages deploy "',
  1,
  "deploy-production-candidate.yml",
  "single production Pages deploy boundary",
);
requireTextCount(
  productionWorkflowContents,
  'CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PAGES_API_TOKEN}" \\\n            pnpm exec wrangler pages deploy "',
  1,
  "deploy-production-candidate.yml",
  "Pages token bound to every production Pages deploy",
);
requireTextCount(
  productionWorkflowContents,
  "${GITHUB_SHA}",
  1,
  "deploy-production-candidate.yml",
  "workflow commit only for current staging run identity",
);
const productionFinalizeCutoverEvidenceStep = workflowStep(
  productionVerificationJob,
  "Verify immutable cutover evidence for finalize",
  "deploy-production-candidate.yml verification job",
);
requireText(
  productionFinalizeCutoverEvidenceStep,
  "node scripts/verify-reusable-workflow-run.mjs",
  "deploy-production-candidate.yml verification job",
  "successful same-release cutover source verification",
);
forbidText(
  productionFinalizeCutoverEvidenceStep,
  'EXPECTED_COMMIT_SHA="${GITHUB_SHA}"',
  "deploy-production-candidate.yml verification job",
  "current workflow head requirement for a completed cutover",
);
forbidText(
  productionFinalizeCutoverEvidenceStep,
  'EXPECTED_STAGING_RUN_ID="${STAGING_RUN_ID}"',
  "deploy-production-candidate.yml verification job",
  "replacement staging evidence rewritten as the cutover source",
);
forbidText(
  workflowStep(
    productionFinalizeJob,
    "Download immutable candidates and cutover evidence",
    "deploy-production-candidate.yml finalize job",
  ),
  'EXPECTED_STAGING_RUN_ID="${STAGING_RUN_ID}"',
  "deploy-production-candidate.yml finalize job",
  "replacement staging evidence rewritten as the cutover source",
);
const productionFinalizeDownloadStep = workflowStep(
  productionFinalizeJob,
  "Download immutable candidates and cutover evidence",
  "deploy-production-candidate.yml finalize job",
);
requireText(
  productionFinalizeDownloadStep,
  'gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${CUTOVER_RUN_ID}"',
  "deploy-production-candidate.yml finalize job",
  "same-job cutover run metadata read",
);
requireText(
  productionFinalizeDownloadStep,
  'printf \'CUTOVER_RUN_PATH=%s\\n\' "${RUNNER_TEMP}/cutover-run.json" >>"${GITHUB_ENV}"',
  "deploy-production-candidate.yml finalize job",
  "same-job cutover run path export",
);
const productionFinalizeEntryStep = workflowStep(
  productionFinalizeJob,
  "Verify exact finalize entry state before mutation",
  "deploy-production-candidate.yml finalize job",
);
requireText(
  productionFinalizeEntryStep,
  '"${{ inputs.finalize_entry_stage }}" "${CUTOVER_RUN_PATH}"',
  "deploy-production-candidate.yml finalize job",
  "same-job cutover run path consumption",
);
for (const [requiredEnvironment, description] of [
  ["GOOGLE_OAUTH_ACCESS_TOKEN:", "Google read-back token"],
  ["SCRIBE_DROP_CLOUD_RUN_SMOKE_EPOCH:", "source cutover epoch"],
  ["SCRIBE_DROP_CLOUD_RUN_OPERATIONAL_EPOCH:", "stable operational epoch"],
  ["SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL:", "operational expiry"],
  ["SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS:", "operational execution bound"],
  ["SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY:", "operational cost bound"],
  ["SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION:", "entry admission"],
]) {
  requireText(
    productionFinalizeEntryStep,
    requiredEnvironment,
    "deploy-production-candidate.yml finalize job",
    `finalize entry verifier ${description}`,
  );
}
if (
  productionFinalizeJob.indexOf("printf 'CUTOVER_RUN_PATH=%s\\n'") >=
  productionFinalizeJob.indexOf("pnpm run production:finalize:entry:verify")
) {
  throw new Error(
    "deploy-production-candidate.yml finalize job: cutover run path must be produced before entry verification",
  );
}
const productionFinalizeDisableStep = workflowStep(
  productionFinalizeJob,
  "Disable the consumed smoke authorization",
  "deploy-production-candidate.yml finalize job",
);
for (const required of [
  "GOOGLE_OAUTH_ACCESS_TOKEN:",
  'SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS: "1"',
  "SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
  "pnpm run cloud-run:controller:deploy apply production disabled",
]) {
  requireText(
    productionFinalizeDisableStep,
    required,
    "deploy-production-candidate.yml finalize job",
    "complete smoke disable command contract",
  );
}
const productionFinalizeOperationalStep = workflowStep(
  productionFinalizeJob,
  "Apply reviewed finite operating authorization",
  "deploy-production-candidate.yml finalize job",
);
for (const required of [
  "GOOGLE_OAUTH_ACCESS_TOKEN:",
  "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
  "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL:",
  "SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS:",
  "SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY:",
  "pnpm run cloud-run:controller:deploy apply production operational",
]) {
  requireText(
    productionFinalizeOperationalStep,
    required,
    "deploy-production-candidate.yml finalize job",
    "complete operational authorization command contract",
  );
}
for (const stepName of [
  "Apply candidate migrations and reviewed R2 policies",
  "Promote exact rollback-compatible RunPod image without execution",
  "Deploy exact application candidate with admission paused",
  "Drain old provider before changing new-attempt selection",
  "Quiesce the expired previous production authorization",
  "Deploy bounded controller after admission drain",
  "Select Cloud Run while keeping admission paused",
  "Verify exact-one L4 authorization and activate admission",
  "Record immutable cutover evidence",
  "Upload immutable cutover evidence",
]) {
  requireText(
    workflowStep(productionCutoverJob, stepName, "deploy-production-candidate.yml cutover job"),
    "if: ${{ !inputs.preflight_only }}",
    "deploy-production-candidate.yml cutover job",
    `${stepName} preflight exclusion`,
  );
}
requireText(
  workflowStep(
    productionVerificationJob,
    "Verify successful mutation-free production preflight before cutover",
    "deploy-production-candidate.yml verification job",
  ),
  "if: inputs.operation == 'cutover' && !inputs.preflight_only",
  "deploy-production-candidate.yml verification job",
  "preflight evidence required before mutating cutover",
);
for (const [jobContents, acceptanceStep, candidateStep, location] of [
  [
    productionCutoverJob,
    "Download acceptance and export exact candidate identity",
    "Download and re-verify exact candidates",
    "deploy-production-candidate.yml cutover job",
  ],
  [
    productionFinalizeJob,
    "Download acceptance and export finalized candidate identity",
    "Download immutable candidates and cutover evidence",
    "deploy-production-candidate.yml finalize job",
  ],
]) {
  const exportStep = workflowStep(jobContents, acceptanceStep, location);
  const downloadStep = workflowStep(jobContents, candidateStep, location);
  requireText(
    exportStep,
    "node scripts/export-staging-acceptance-identity.mjs staging-acceptance",
    location,
    "acceptance identity export",
  );
  forbidText(
    exportStep,
    "${CANDIDATE_RUN_ID}",
    location,
    "same-step use of a GITHUB_ENV candidate identity",
  );
  requireText(
    downloadStep,
    'gh run download "${CANDIDATE_RUN_ID}"',
    location,
    "next-step candidate identity consumption",
  );
}

requireTextCount(
  productionWorkflowContents,
  "pnpm run cloud-run:controller:deploy preflight production disabled",
  3,
  "deploy-production-candidate.yml",
  "controller preflight before both production mutations",
);
requireText(
  workflowStep(
    productionCutoverJob,
    "Build verifier and strictly read production foundation",
    "deploy-production-candidate.yml cutover job",
  ),
  'SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS: "0"',
  "deploy-production-candidate.yml cutover job",
  "cutover requires disabled zero authorization before mutation",
);
requireText(
  workflowStep(
    productionCutoverJob,
    "Build verifier and strictly read production foundation",
    "deploy-production-candidate.yml cutover job",
  ),
  "SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: disabled",
  "deploy-production-candidate.yml cutover job",
  "cutover requires the exact disabled authorization epoch",
);
requireText(
  workflowStep(
    productionVerificationJob,
    "Verify previous production release entry before cutover",
    "deploy-production-candidate.yml verification job",
  ),
  "pnpm run --silent production:upgrade:entry export",
  "deploy-production-candidate.yml verification job",
  "previous production release entry contract",
);
for (const [stepName, required] of [
  [
    "Export verified previous production upgrade entry",
    "pnpm run --silent production:upgrade:entry export",
  ],
  [
    "Quiesce the expired previous production authorization",
    "pnpm run cloud-run:controller:deploy quiesce production disabled",
  ],
]) {
  requireText(
    workflowStep(productionCutoverJob, stepName, "deploy-production-candidate.yml cutover job"),
    required,
    "deploy-production-candidate.yml cutover job",
    `${stepName} upgrade contract`,
  );
}
requireText(
  workflowStep(
    productionFinalizeJob,
    "Build verifier and reconstruct exact production entry configuration",
    "deploy-production-candidate.yml finalize job",
  ),
  'SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS: "1"',
  "deploy-production-candidate.yml finalize job",
  "finalize requires exactly one consumed smoke authorization",
);
requireText(
  workflowStep(
    productionFinalizeJob,
    "Build verifier and reconstruct exact production entry configuration",
    "deploy-production-candidate.yml finalize job",
  ),
  "SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
  "deploy-production-candidate.yml finalize job",
  "finalize requires the exact source cutover smoke epoch",
);

requireTextCount(
  productionWorkflowContents,
  "--cwd apps/web",
  2,
  "deploy-production-candidate.yml",
  "Pages app-root config discovery",
);
requireTextOrder(
  productionWorkflowContents,
  "Verify every external control plane before production mutation",
  "Apply candidate migrations and reviewed R2 policies",
  "deploy-production-candidate.yml",
  "all preflights before production mutation",
);
requireTextOrder(
  productionWorkflowContents,
  "Deploy exact application candidate with admission paused",
  "Drain old provider before changing new-attempt selection",
  "deploy-production-candidate.yml",
  "admission pause before provider drain",
);
requireTextOrder(
  productionWorkflowContents,
  "Drain old provider before changing new-attempt selection",
  "Quiesce the expired previous production authorization",
  "deploy-production-candidate.yml",
  "provider drain before authorization quiesce",
);
requireTextOrder(
  productionWorkflowContents,
  "Quiesce the expired previous production authorization",
  "Deploy bounded controller after admission drain",
  "deploy-production-candidate.yml",
  "expired authorization quiesce before smoke authorization",
);
requireTextOrder(
  productionWorkflowContents,
  "Deploy bounded controller after admission drain",
  "Select Cloud Run while keeping admission paused",
  "deploy-production-candidate.yml",
  "old provider drain before provider selection",
);
requireTextOrder(
  productionWorkflowContents,
  "Select Cloud Run while keeping admission paused",
  "Verify exact-one L4 authorization and activate admission",
  "deploy-production-candidate.yml",
  "paused provider selection before exact-one admission",
);
requireTextOrder(
  productionWorkflowContents,
  "Verify exact finalize entry state before mutation",
  "Pause admission before changing authorization",
  "deploy-production-candidate.yml",
  "entry proof before pausing admission",
);
requireTextOrder(
  productionWorkflowContents,
  "Pause admission before changing authorization",
  "Disable the consumed smoke authorization",
  "deploy-production-candidate.yml",
  "paused admission before disabling smoke authorization",
);
requireTextOrder(
  productionWorkflowContents,
  "Disable the consumed smoke authorization",
  "Apply reviewed finite operating authorization",
  "deploy-production-candidate.yml",
  "disabled smoke authorization before operating authorization",
);
requireTextOrder(
  productionWorkflowContents,
  "Apply reviewed finite operating authorization",
  "Activate admission after exact operational authorization",
  "deploy-production-candidate.yml",
  "operational authorization before active admission",
);
requireTextOrder(
  productionWorkflowContents,
  "Promote exact rollback-compatible RunPod image without execution",
  "Deploy exact application candidate with admission paused",
  "deploy-production-candidate.yml",
  "rollback image promotion before public Web deployment",
);
requireText(
  cloudflareReadbackScriptContents,
  "deployment_configs?.production?.wrangler_config_hash",
  "cloudflare-readback.mjs",
  "Pages deployed configuration hash read-back",
);
requireText(
  cloudflareReadbackScriptContents,
  'createHash("sha256").update(readFileSync(input.pagesConfigPath)).digest("hex")',
  "cloudflare-readback.mjs",
  "generated Pages configuration hash",
);

for (const [description, value] of Object.entries({
  "production container rebuild": "docker build",
  "production application rebuild": "pnpm run build",
  "direct legacy production RunPod deploy": "runpod:deploy:production",
  "staging Access client ID in production": "CF_ACCESS_CLIENT_ID",
  "staging Access client secret in production": "CF_ACCESS_CLIENT_SECRET",
  "staging E2E identity in production": "STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  "deploy-config directory as production Pages cwd": "--cwd apps/web/.wrangler/deploy",
})) {
  forbidText(productionWorkflowContents, value, "deploy-production-candidate.yml", description);
}

requireText(
  runpodDeploymentScriptContents,
  "Direct production RunPod deployment is prohibited; use the ADR 0023 promotion workflow",
  "deploy-runpod-environment.mjs",
  "fail-closed production promotion guard",
);
requireText(
  runpodDeploymentScriptContents,
  "reconcileRunpodEndpointCapacity({",
  "deploy-runpod-environment.mjs",
  "tested endpoint capacity reconciliation",
);
requireText(
  runpodPromotionScriptContents,
  "runRunpodCliWithReadRetry(arguments_, runCliOnce",
  "promote-runpod-candidate.mjs",
  "bounded read-only RunPod CLI retry",
);
requireText(
  runpodPromotionScriptContents,
  "clearRunpodTemplatePorts({",
  "promote-runpod-candidate.mjs",
  "fixed template API port normalization",
);
requireText(
  runpodPromotionScriptContents,
  "setRunpodEndpointWorkersMax({",
  "promote-runpod-candidate.mjs",
  "fixed endpoint worker drain",
);
requireTextCount(
  runpodPromotionLibraryContents,
  "RunPod production endpoint capacity must match the fixed plan before promotion",
  2,
  "runpod-promotion.mjs",
  "production capacity drift guards in preflight and promotion",
);
requireText(
  runpodPromotionLibraryContents,
  "const capacityReadBackDelaysMilliseconds = [1_000, 2_000, 4_000, 8_000, 15_000];",
  "runpod-promotion.mjs",
  "bounded capacity convergence read-back",
);
requireText(
  runpodPromotionLibraryContents,
  "function validateCapacityPreparationDrainedEndpoint",
  "runpod-promotion.mjs",
  "terminal worker history-safe capacity drain",
);
requireText(
  runpodPromotionLibraryContents,
  "await waitForDrainedHealth(input, endpointId);",
  "runpod-promotion.mjs",
  "pre-capacity drained health read-back",
);
requireText(
  packageManifestContents,
  '"runpod:capacity:prepare:production": "node scripts/prepare-runpod-production-capacity.mjs"',
  "package.json",
  "explicit production capacity preparation command",
);
for (const [description, value] of Object.entries({
  "explicit production confirmation": "--confirm-production-capacity-migration",
  "local-only capacity preparation": "cannot run in GitHub Actions",
  "job and worker health read-back": "getRunpodEndpointHealth({",
  "tested capacity preparation boundary": "prepareRunpodProductionCapacity({",
})) {
  requireText(
    runpodProductionCapacityPreparationContents,
    value,
    "prepare-runpod-production-capacity.mjs",
    description,
  );
}
for (const [description, value] of Object.entries({
  "GraphQL endpoint data-center promotion": "setRunpodEndpointDataCenters({",
  "REST endpoint GPU promotion": "setRunpodEndpointGpuTypes({",
})) {
  requireText(runpodPromotionScriptContents, value, "promote-runpod-candidate.mjs", description);
}
forbidText(
  `${runpodPromotionScriptContents}\n${runpodProductionCapacityPreparationContents}`,
  "setRunpodEndpointCapacity",
  "RunPod capacity mutation adapters",
  "unverified combined REST capacity update",
);
requireText(
  runpodEnvironmentConfigScriptContents,
  `const fixedGpuTypeIds = [
  "NVIDIA GeForce RTX 5090",
  "NVIDIA GeForce RTX 4090",
  "NVIDIA RTX PRO 6000 Blackwell Server Edition",
];`,
  "runpod-environment-config.mjs",
  "runtime-attested Secure GPU policy",
);
requireText(
  runpodEnvironmentConfigScriptContents,
  "const fixedDataCenterIds = [];",
  "runpod-environment-config.mjs",
  "fixed RunPod data-center policy",
);
requireText(
  runpodEnvironmentConfigScriptContents,
  "const fixedCompliance = [];",
  "runpod-environment-config.mjs",
  "capacity-preserving RunPod compliance policy",
);
forbidText(
  workflowContents,
  "RUNPOD_DATACENTER_IDS",
  ".github/workflows",
  "unverifiable RunPod data-center policy",
);
requireText(
  runpodPromotionScriptContents,
  "getRunpodEndpointCapacity({",
  "promote-runpod-candidate.mjs",
  "exact endpoint capacity read-back",
);
requireText(
  runpodPromotionScriptContents,
  "await verifyRunpodCandidateWorkerEvidence(preflightInput);",
  "promote-runpod-candidate.mjs",
  "dedicated read-only post-lifecycle candidate worker evidence verification",
);
requireText(
  runpodPromotionScriptContents,
  'runCli(["gpu", "list", "--include-unavailable"])',
  "promote-runpod-candidate.mjs",
  "dynamic RunPod GPU inventory gate",
);
requireText(
  runpodTemplateApiScriptContents,
  'pathname: "/v1/openapi.json"',
  "runpod-template-api.mjs",
  "public Serverless OpenAPI GPU support boundary",
);
requireText(
  runpodTemplateApiScriptContents,
  "serverlessGpuPools",
  "runpod-template-api.mjs",
  "authenticated Serverless GPU pool support boundary",
);
for (const [pathname, contents] of [
  ["deploy-runpod-environment.mjs", runpodDeploymentScriptContents],
  ["promote-runpod-candidate.mjs", runpodPromotionScriptContents],
  ["prepare-runpod-production-capacity.mjs", runpodProductionCapacityPreparationContents],
  ["verify-runpod-release-readiness.mjs", runpodReleaseReadinessScriptContents],
]) {
  requireText(
    contents,
    "verifyRunpodServerlessGpuTypes(",
    pathname,
    "Serverless OpenAPI GPU support preflight",
  );
  requireText(
    contents,
    "verifyRunpodServerlessGpuPools(",
    pathname,
    "authenticated Serverless GPU pool support preflight",
  );
}
requireText(
  runpodPromotionScriptContents,
  "listRunpodTemplates(",
  "promote-runpod-candidate.mjs",
  "official REST template-list read",
);
forbidText(
  runpodPromotionScriptContents,
  'runCli(["template", "list"',
  "promote-runpod-candidate.mjs",
  "CLI template-list fallback",
);
requireText(
  runpodTemplateApiScriptContents,
  "JSON.stringify({ ports: [] })",
  "runpod-template-api.mjs",
  "automatic empty-port normalization",
);
requireText(
  runpodTemplateApiScriptContents,
  "JSON.stringify({ workersMax: input.workersMax })",
  "runpod-template-api.mjs",
  "bounded endpoint worker drain mutation",
);
requireText(
  runpodTemplateApiScriptContents,
  'locations: dataCenterIds.length === 0 ? null : dataCenterIds.join(",")',
  "runpod-template-api.mjs",
  "GraphQL endpoint data-center mutation",
);
requireText(
  runpodTemplateApiScriptContents,
  "JSON.stringify({ gpuTypeIds })",
  "runpod-template-api.mjs",
  "REST-only ordered endpoint GPU fallback mutation",
);
forbidText(
  runpodTemplateApiScriptContents,
  "JSON.stringify({ dataCenterIds, gpuTypeIds })",
  "runpod-template-api.mjs",
  "combined REST data-center and GPU mutation",
);
requireText(
  runpodTemplateApiScriptContents,
  'query: { includeEndpointBoundTemplates: "true" }',
  "runpod-template-api.mjs",
  "endpoint-bound template enumeration",
);
requireText(
  runpodTemplateApiScriptContents,
  "query ScribeDropEndpointPlacement($id: String!)",
  "runpod-template-api.mjs",
  "Console-equivalent endpoint placement read-back",
);
requireText(
  runpodTemplateApiScriptContents,
  "getRunpodEndpointCapacity(input, dependencies",
  "runpod-template-api.mjs",
  "combined REST and GraphQL capacity boundary",
);
requireText(
  runpodTemplateApiScriptContents,
  "await Promise.all([",
  "runpod-template-api.mjs",
  "parallel bounded RunPod readiness reads",
);
requireText(
  runpodReleaseReadinessScriptContents,
  "verifyRunpodReleaseReadiness(",
  "verify-runpod-release-readiness.mjs",
  "official REST readiness boundary",
);
requireText(
  runpodReleaseReadinessScriptContents,
  '["gpu", "list", "--include-unavailable"]',
  "verify-runpod-release-readiness.mjs",
  "GPU inventory before costly candidate work",
);
requireText(
  runpodReleaseReadinessScriptContents,
  "validateRunpodGpuInventoryPolicyConfiguration(",
  "verify-runpod-release-readiness.mjs",
  "publication-safe Secure-capable candidate inventory policy",
);
requireText(
  publicationPreflightJob,
  "SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS: ${{ vars.SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS }}",
  "publish-runpod-worker.yml preflight job",
  "staging GPU fallback policy input",
);
for (const [contents, location, prefix] of [
  [stagingWorkflowContents, "deploy-staging-candidate.yml", "STAGING"],
  [productionWorkflowContents, "deploy-production-candidate.yml", "PRODUCTION"],
]) {
  requireText(
    contents,
    `SCRIBE_DROP_${prefix}_RUNPOD_GPU_IDS:`,
    location,
    "ordered RunPod GPU fallback variable",
  );
  forbidText(
    contents,
    `SCRIBE_DROP_${prefix}_RUNPOD_GPU_ID:`,
    location,
    "legacy single RunPod GPU variable",
  );
}

if (failures.length > 0) {
  console.error("CI workflow verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `CI workflow verification passed (${workflowFiles.length} workflow, ${actionReferenceCount} pinned action references).`,
  );
  console.log(`Staging workflow state contract: ${JSON.stringify(stagingWorkflowStateContract)}`);
  console.log(
    `Workflow controller build contract: ${JSON.stringify(workflowControllerBuildContract)}`,
  );
}
