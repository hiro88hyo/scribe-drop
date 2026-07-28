import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const packageManifestPath = path.join(repositoryRoot, "package.json");
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
const stagingAuthPath = path.join(repositoryRoot, "apps", "e2e", "staging-auth.ts");
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
const runpodTemplateApiScriptPath = path.join(repositoryRoot, "scripts", "runpod-template-api.mjs");
const runpodReleaseReadinessScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-runpod-release-readiness.mjs",
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
const packageManifestContents = readFileSync(packageManifestPath, "utf8");
const ciWorkflowContents = readFileSync(ciWorkflowPath, "utf8");
const publicationWorkflowContents = readFileSync(publicationWorkflowPath, "utf8");
const stagingWorkflowContents = readFileSync(stagingWorkflowPath, "utf8");
const productionWorkflowContents = readFileSync(productionWorkflowPath, "utf8");
const cloudflareReadbackScriptContents = readFileSync(cloudflareReadbackScriptPath, "utf8");
const stagingE2eContents = readFileSync(stagingE2ePath, "utf8");
const stagingAuthContents = readFileSync(stagingAuthPath, "utf8");
const releaseCandidateScriptContents = readFileSync(releaseCandidateScriptPath, "utf8");
const runpodDeploymentScriptContents = readFileSync(runpodDeploymentScriptPath, "utf8");
const runpodPromotionScriptContents = readFileSync(runpodPromotionScriptPath, "utf8");
const runpodTemplateApiScriptContents = readFileSync(runpodTemplateApiScriptPath, "utf8");
const runpodReleaseReadinessScriptContents = readFileSync(runpodReleaseReadinessScriptPath, "utf8");
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
  "read-only readiness before costly work": "pnpm run runpod:release-readiness:staging",
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

requireTextCount(
  publicationWorkflowContents,
  "pnpm run build",
  1,
  "publish-runpod-worker.yml",
  "single candidate application build",
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

for (const [description, value] of Object.entries({
  "environment-specific publication input": "target_environment",
  "develop-only candidate publication": "refs/heads/develop",
  "production deployment in build workflow": "environment: production",
  "RunPod mutation in candidate workflow": "runpod:promote:",
  "Cloudflare mutation credential in candidate workflow": "CLOUDFLARE_API_TOKEN",
  "multipart Orchestrator upload body output": "--outfile candidate-build/orchestrator/index.js",
  "config-relative Orchestrator output": "--outdir candidate-build/orchestrator",
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
  "read-only RunPod preflight": "pnpm run runpod:preflight:staging",
  "candidate migration directory":
    "SCRIBE_DROP_CANDIDATE_MIGRATIONS_DIR: ../../release-candidate/migrations",
  "candidate-only RunPod promotion": "pnpm run runpod:promote:staging",
  "staging environment parity evidence": "pnpm run environment:policy:export staging",
  "Orchestrator no-rebuild deployment": "wrangler deploy release-candidate/orchestrator/index.js",
  "Pages no-rebuild deployment": "--no-bundle",
  "live Cloudflare read-back": "pnpm run cloudflare:readback:staging",
  "early authenticated Pages readiness": "pnpm run test:e2e:staging:readiness",
  "real service E2E": "pnpm run test:e2e:staging",
  "staging-only Access client ID": "CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}",
  "staging-only Access client secret":
    "CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}",
  "staging acceptance creation": "pnpm run staging:acceptance:create",
  "staging acceptance artifact": "scribe-drop-staging-acceptance-${{ github.sha }}",
})) {
  requireText(stagingWorkflowContents, value, "deploy-staging-candidate.yml", description);
}

requireTextCount(
  stagingWorkflowContents,
  "--cwd apps/web",
  2,
  "deploy-staging-candidate.yml",
  "Pages app-root config discovery",
);
requireTextOrder(
  stagingWorkflowContents,
  "Verify Pages deploy configuration and target",
  "Apply candidate D1 migrations",
  "deploy-staging-candidate.yml",
  "Pages preflight before staging mutation",
);
requireTextOrder(
  stagingWorkflowContents,
  "Verify RunPod control plane before any mutation",
  "Apply candidate D1 migrations",
  "deploy-staging-candidate.yml",
  "RunPod preflight before staging mutation",
);
requireTextOrder(
  stagingWorkflowContents,
  "Install fixed Playwright browser before remote mutation",
  "Apply candidate D1 migrations",
  "deploy-staging-candidate.yml",
  "browser installation before staging mutation",
);
requireTextOrder(
  stagingWorkflowContents,
  "Apply candidate D1 migrations",
  "Deploy exact candidate Pages output",
  "deploy-staging-candidate.yml",
  "migration before candidate Pages deployment",
);
requireTextOrder(
  stagingWorkflowContents,
  "Deploy exact candidate Pages output",
  "Verify authenticated Pages data plane before backend promotion",
  "deploy-staging-candidate.yml",
  "candidate Pages deployment before data-plane readiness",
);
requireTextOrder(
  stagingWorkflowContents,
  "Verify authenticated Pages data plane before backend promotion",
  "Apply reviewed R2 browser and retention policies",
  "deploy-staging-candidate.yml",
  "data-plane readiness before R2 mutation",
);
requireTextOrder(
  stagingWorkflowContents,
  "Verify authenticated Pages data plane before backend promotion",
  "Promote the candidate RunPod image",
  "deploy-staging-candidate.yml",
  "data-plane readiness before RunPod promotion",
);
requireTextOrder(
  stagingWorkflowContents,
  "Deploy exact candidate Pages output",
  "Verify candidate and live resource read-back",
  "deploy-staging-candidate.yml",
  "Pages deployment before live configuration read-back",
);

for (const [description, value] of Object.entries({
  "same-origin Access credential routing": "headersForAccessRequest(",
  "redirect boundary before credential reuse": "maxRedirects: 0",
  "service-token cookie identity check": "serviceTokenCookieMatchesExpectedIdentity(",
  "authenticated session preflight": 'fetch("/api/me"',
  "bounded Pages data-plane convergence":
    "Expected the authenticated staging data plane to converge",
})) {
  requireText(stagingAuthContents, value, "staging-auth.ts", description);
}
forbidText(
  stagingAuthContents,
  "extraHTTPHeaders:",
  "staging-auth.ts",
  "context-wide Access service credentials",
);
requireTextOrder(
  stagingE2eContents,
  "waitForAuthenticatedStagingDataPlane(page)",
  ".setInputFiles",
  "release-candidate.spec.ts",
  "data-plane readiness before media mutation",
);
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
  "Verify Pages deploy configuration and target",
  "Apply candidate D1 migrations",
  "deploy-production-candidate.yml",
  "Pages preflight before production mutation",
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
  'query: { includeEndpointBoundTemplates: "true" }',
  "runpod-template-api.mjs",
  "endpoint-bound template enumeration",
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
