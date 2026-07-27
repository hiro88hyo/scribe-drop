import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const publicationWorkflowPath = path.join(workflowsDirectory, "publish-runpod-worker.yml");
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
const dockerfileContents = readFileSync(dockerfilePath, "utf8");
const modelBundleContents = readFileSync(modelBundlePath, "utf8");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
const image = versions.runpodWorkerImage;

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
  "publication environment input": "inputs.target_environment",
  "staging publication guard": "refs/heads/develop",
  "production release guard": "refs/heads/release/",
  "release version comparison": "Production branch and package version must match",
  "package write permission": "packages: write",
  "commit-addressed image tag": "git-${GITHUB_SHA}",
  "password-stdin registry login": "--password-stdin",
  "immutable image reference evidence": "runpod-worker-image.txt",
})) {
  requireText(publicationWorkflowContents, value, "publish-runpod-worker.yml", description);
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
