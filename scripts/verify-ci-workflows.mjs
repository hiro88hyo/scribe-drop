import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const publicationWorkflowPath = path.join(workflowsDirectory, "publish-runpod-worker.yml");
const stagingWorkflowPath = path.join(workflowsDirectory, "deploy-staging-candidate.yml");
const productionWorkflowPath = path.join(workflowsDirectory, "deploy-production-candidate.yml");
const runpodDeploymentScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "deploy-runpod-environment.mjs",
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
const publicationWorkflowContents = readFileSync(publicationWorkflowPath, "utf8");
const stagingWorkflowContents = readFileSync(stagingWorkflowPath, "utf8");
const productionWorkflowContents = readFileSync(productionWorkflowPath, "utf8");
const runpodDeploymentScriptContents = readFileSync(runpodDeploymentScriptPath, "utf8");
const dockerfileContents = readFileSync(dockerfilePath, "utf8");
const modelBundleContents = readFileSync(modelBundlePath, "utf8");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
const image = versions.runpodWorkerImage;

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
  "raw Orchestrator module output": "--outdir candidate-build/orchestrator",
  "environment-neutral candidate evidence": "scribe-drop-release-candidate-${{ github.sha }}",
  "candidate manifest creation": "pnpm run candidate:create",
  "candidate manifest verification": "pnpm run candidate:verify",
  "candidate preflight dependency": "- preflight",
  "preflight before quality work":
    "quality:\n    name: Candidate quality gate\n    needs: preflight",
  "candidate quality dependency": "- quality",
  "candidate browser E2E dependency": "- browser-e2e",
  "candidate security dependency": "- security",
})) {
  requireText(publicationWorkflowContents, value, "publish-runpod-worker.yml", description);
}

for (const [description, value] of Object.entries({
  "environment-specific publication input": "target_environment",
  "develop-only candidate publication": "refs/heads/develop",
  "staging deployment in build workflow": "environment: staging",
  "production deployment in build workflow": "environment: production",
  "multipart Orchestrator upload body output": "--outfile candidate-build/orchestrator/index.js",
})) {
  forbidText(publicationWorkflowContents, value, "publish-runpod-worker.yml", description);
}

for (const [description, value] of Object.entries({
  "staging candidate workflow name": "name: Deploy release candidate to staging",
  "staging Environment isolation": "environment: staging",
  "trusted candidate run verification": ".github/workflows/publish-runpod-worker.yml",
  "candidate artifact download": "scribe-drop-release-candidate-${GITHUB_SHA}",
  "verified Pages assembly": "pnpm run candidate:pages",
  "candidate migration directory":
    "SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR: ../../release-candidate/migrations",
  "candidate-only RunPod promotion": "pnpm run runpod:promote:staging",
  "staging environment parity evidence": "pnpm run environment:policy:export staging",
  "Orchestrator no-rebuild deployment": "wrangler deploy release-candidate/orchestrator/index.js",
  "Pages no-rebuild deployment": "--no-bundle",
  "live Cloudflare read-back": "pnpm run cloudflare:readback:staging",
  "real service E2E": "pnpm run test:e2e:staging",
  "staging-only Access client ID": "CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}",
  "staging-only Access client secret":
    "CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
  "staging acceptance creation": "pnpm run staging:acceptance:create",
  "staging acceptance artifact": "scribe-drop-staging-acceptance-${{ github.sha }}",
})) {
  requireText(stagingWorkflowContents, value, "deploy-staging-candidate.yml", description);
}

for (const [description, value] of Object.entries({
  "staging container rebuild": "docker build",
  "staging application rebuild": "pnpm run build",
  "direct legacy staging RunPod deploy": "runpod:deploy:staging",
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

for (const [description, value] of Object.entries({
  "production container rebuild": "docker build",
  "production application rebuild": "pnpm run build",
  "direct legacy production RunPod deploy": "runpod:deploy:production",
  "staging Access client ID in production": "CF_ACCESS_CLIENT_ID",
  "staging Access client secret in production": "CF_ACCESS_CLIENT_SECRET",
  "staging E2E identity in production": "STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
})) {
  forbidText(productionWorkflowContents, value, "deploy-production-candidate.yml", description);
}

requireText(
  runpodDeploymentScriptContents,
  "Direct production RunPod deployment is prohibited; use the ADR 0023 promotion workflow",
  "deploy-runpod-environment.mjs",
  "fail-closed production promotion guard",
);

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
