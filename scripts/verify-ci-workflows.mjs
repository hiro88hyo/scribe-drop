import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const packageManifestPath = path.join(repositoryRoot, "package.json");
const stagingE2ePackageManifestPath = path.join(repositoryRoot, "apps", "e2e", "package.json");
const ciWorkflowPath = path.join(workflowsDirectory, "ci.yml");
const publicationWorkflowPath = path.join(workflowsDirectory, "publish-runpod-worker.yml");
const stagingWorkflowPath = path.join(workflowsDirectory, "deploy-staging-candidate.yml");
const productionWorkflowPath = path.join(workflowsDirectory, "deploy-production-candidate.yml");
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
  "Scan image vulnerabilities",
  "create-runpod-worker-provenance.mjs",
  "publish-runpod-worker.yml",
  "current vulnerability scan before provenance and candidate creation",
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
  "synthetic failure evidence in runner temp":
    "STAGING_FAILURE_EVIDENCE_PATH: ${{ runner.temp }}/staging-failure-evidence.json",
  "real failure notification verification":
    'pnpm run staging:failure-notification:verify "${STAGING_FAILURE_EVIDENCE_PATH}"',
  "real failure notification lifecycle":
    "pnpm --filter @scribe-drop/e2e run test:staging:failure-notification",
  "synthetic failure cleanup": "pnpm --filter @scribe-drop/e2e run test:staging:failure-cleanup",
  "staging-only Access client ID": "CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}",
  "staging-only Access client secret":
    "CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
  "staging acceptance creation": "pnpm run staging:acceptance:create",
  "staging acceptance artifact": "scribe-drop-staging-acceptance-${{ github.sha }}",
})) {
  requireText(stagingWorkflowContents, value, "deploy-staging-candidate.yml", description);
}

const absoluteCandidateDirectory =
  "RELEASE_CANDIDATE_DIRECTORY: ${{ github.workspace }}/release-candidate";
requireTextCount(
  stagingWorkflowContents,
  absoluteCandidateDirectory,
  5,
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

requireTextCount(
  stagingWorkflowContents,
  "--cwd apps/web",
  1,
  "deploy-staging-candidate.yml",
  "read-only Pages app-root config discovery",
);
for (const [job, expected, description] of [
  [stagingMigrationJob, "needs: preflight", "migration dependency on preflight"],
  [stagingPagesDeploymentJob, "needs: migrate", "Pages dependency on migration"],
  [stagingBackendJob, "needs: deploy-pages", "backend dependency on exact Pages deployment"],
  [stagingAcceptanceJob, "needs: deploy-backend", "acceptance dependency on backend promotion"],
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
  4,
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
  "Install fixed Playwright browser",
  "Prewarm the exact candidate worker before creating a job",
  "deploy-staging-candidate.yml acceptance job",
  "browser installation before candidate worker prewarm",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Prewarm the exact candidate worker before creating a job",
  "Verify authenticated data plane, then run real staging M4A lifecycle",
  "deploy-staging-candidate.yml acceptance job",
  "candidate worker readiness before the acceptance data-plane gate",
);
requireTextCount(
  stagingWorkflowContents,
  "pnpm run runpod:preflight:staging",
  2,
  "deploy-staging-candidate.yml",
  "RunPod preflight and pre-lifecycle read-back",
);
requireTextCount(
  stagingWorkflowContents,
  "pnpm run runpod:verify-worker:staging",
  2,
  "deploy-staging-candidate.yml",
  "post-success and post-failure candidate worker evidence",
);
requireText(
  packageManifestContents,
  '"runpod:prewarm:staging": "node scripts/manage-staging-runpod-active-worker.mjs prewarm"',
  "package.json",
  "bounded staging candidate worker prewarm script",
);
requireText(
  packageManifestContents,
  '"runpod:cooldown:staging": "node scripts/manage-staging-runpod-active-worker.mjs cooldown"',
  "package.json",
  "staging scale-to-zero restoration script",
);
requireText(
  stagingAcceptanceJob,
  "if: ${{ always() }}",
  "deploy-staging-candidate.yml acceptance job",
  "scale-to-zero cleanup after every staging outcome",
);
requireTextCount(
  stagingAcceptanceJob,
  "pnpm run runpod:prewarm:staging",
  2,
  "deploy-staging-candidate.yml acceptance job",
  "idle candidate worker gate before both real jobs",
);
requireTextCount(
  stagingAcceptanceJob,
  "pnpm run runpod:cooldown:staging",
  1,
  "deploy-staging-candidate.yml acceptance job",
  "single staging scale-to-zero restoration",
);
requireText(
  packageManifestContents,
  '"runpod:verify-worker:staging": "node scripts/promote-runpod-candidate.mjs staging .runpod/deploy/staging-plan.json --preflight-only --require-candidate-worker"',
  "package.json",
  "post-lifecycle candidate worker verification script",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify authenticated data plane, then run real staging M4A lifecycle",
  "Verify the candidate RunPod worker handled the successful lifecycle",
  "deploy-staging-candidate.yml acceptance job",
  "candidate worker read-back after real staging E2E",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify the candidate RunPod worker handled the successful lifecycle",
  "Wait for an idle candidate worker before the failure fixture",
  "deploy-staging-candidate.yml acceptance job",
  "successful worker evidence before second idle gate",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Wait for an idle candidate worker before the failure fixture",
  "Run real staging failure notification lifecycle",
  "deploy-staging-candidate.yml acceptance job",
  "second idle candidate gate before the failure fixture",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Run real staging failure notification lifecycle",
  "Verify the candidate RunPod worker handled the failure fixture",
  "deploy-staging-candidate.yml acceptance job",
  "failure lifecycle before candidate worker evidence",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify the candidate RunPod worker handled the failure fixture",
  "Verify the synthetic failure notification was delivered",
  "deploy-staging-candidate.yml acceptance job",
  "failure worker evidence before failure notification verification",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Verify the synthetic failure notification was delivered",
  "Delete the synthetic staging failure fixture",
  "deploy-staging-candidate.yml acceptance job",
  "failure notification delivery before fixture deletion",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Delete the synthetic staging failure fixture",
  "Restore staging scale-to-zero",
  "deploy-staging-candidate.yml acceptance job",
  "failure fixture cleanup before scale-to-zero restoration",
);
requireTextOrder(
  stagingAcceptanceJob,
  "Restore staging scale-to-zero",
  "Issue short-lived staging acceptance",
  "deploy-staging-candidate.yml acceptance job",
  "scale-to-zero restoration before staging acceptance issuance",
);
requireTextCount(
  productionWorkflowContents,
  "pnpm run runpod:preflight:production",
  2,
  "deploy-production-candidate.yml",
  "RunPod preflight and post-promotion read-back",
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
  "verification before production Environment":
    "needs: verify-promotion\n    environment: production",
  "trusted staging run verification": ".github/workflows/deploy-staging-candidate.yml",
  "trusted candidate run verification": ".github/workflows/publish-runpod-worker.yml",
  "staging acceptance verification": "pnpm run staging:acceptance:verify",
  "candidate verification": "pnpm run candidate:verify",
  "production Pages upload capability preflight":
    "pnpm run cloudflare:pages:upload-permission:verify:production",
  "production Worker route capability preflight":
    "pnpm run cloudflare:worker-route:verify:production",
  "dedicated production Pages token":
    "CLOUDFLARE_PAGES_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  "read-only Pages deploy preflight": "wrangler pages deployment list",
  "read-only RunPod preflight": "pnpm run runpod:preflight:production",
  "candidate migration directory":
    "SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR: ../../release-candidate/migrations",
  "candidate-only production RunPod promotion": "pnpm run runpod:promote:production",
  "production environment parity comparison": "pnpm run environment:policy:export production",
  "minimum production acceptance validity": 'MINIMUM_ACCEPTANCE_REMAINING_SECONDS: "1800"',
  "production no-rebuild deployment": "--no-bundle",
  "production live read-back": "pnpm run cloudflare:readback:production",
  "production Access read-back": "pnpm run cloudflare:access:verify:production",
})) {
  requireText(productionWorkflowContents, value, "deploy-production-candidate.yml", description);
}

requireTextCount(
  productionWorkflowContents,
  "--cwd apps/web",
  2,
  "deploy-production-candidate.yml",
  "Pages app-root config discovery",
);
requireTextOrder(
  productionWorkflowContents,
  "Verify Pages upload permission before any mutation",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "Pages upload permission before production mutation",
);
requireTextOrder(
  productionWorkflowContents,
  "Verify Pages deploy configuration and target",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "Pages preflight before production mutation",
);
requireTextOrder(
  productionWorkflowContents,
  "pnpm run cloudflare:config:production",
  "pnpm run cloudflare:worker-route:verify:production",
  "deploy-production-candidate.yml",
  "rendered custom-domain configuration before production Worker route preflight",
);
requireTextOrder(
  productionWorkflowContents,
  "pnpm run cloudflare:worker-route:verify:production",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "Worker route preflight before production mutation",
);
requireTextCount(
  productionWorkflowContents,
  "${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}",
  5,
  "deploy-production-candidate.yml",
  "dedicated production Pages token usage",
);
requireTextOrder(
  productionWorkflowContents,
  "Verify RunPod control plane before any mutation",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "RunPod preflight before production mutation",
);
requireTextOrder(
  productionWorkflowContents,
  "Reject staging and production policy drift",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "policy verification before production mutation",
);
requireTextOrder(
  productionWorkflowContents,
  "Promote the exact candidate RunPod image",
  "Deploy exact candidate Pages output",
  "deploy-production-candidate.yml",
  "RunPod promotion before public Web deployment",
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
  'const fixedGpuTypeIds = ["NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 4090"];',
  "runpod-environment-config.mjs",
  "runtime-attested Secure GPU policy",
);
requireText(
  runpodEnvironmentConfigScriptContents,
  'const fixedDataCenterIds = ["EUR-IS-1", "EU-RO-1"];',
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
  'locations: dataCenterIds.join(",")',
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
}
