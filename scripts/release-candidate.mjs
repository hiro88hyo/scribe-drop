import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const candidateSchemaVersion = 1;
const candidatePolicyVersion = "adr-0023-v2";
const commitShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const imagePattern =
  /^(ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/scribe-drop-runpod-worker)@sha256:([0-9a-f]{64})$/u;
const releaseVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const candidateDirectories = [
  "acceptance-fixtures",
  "migrations",
  "orchestrator",
  "pages-functions",
  "supply-chain",
  "web-assets",
];
const candidateApplicationDirectories = ["orchestrator", "pages-functions", "web-assets"];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name) {
  const record = requireRecord(value, name);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains unexpected or missing fields`);
  }
  return record;
}

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function listRegularFiles(root) {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    throw new Error("Candidate artifact directory is missing");
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(absolutePath).isSymbolicLink()) {
        throw new Error("Candidate artifacts must not contain symbolic links");
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      } else {
        throw new Error("Candidate artifacts must contain only regular files");
      }
    }
  };
  visit(root);
  if (files.length === 0) {
    throw new Error("Candidate artifact directory must not be empty");
  }
  return files;
}

function verifyCandidateLayout(root) {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    throw new Error("Release candidate directory is missing or invalid");
  }
  const expectedEntries = [...candidateDirectories, "candidate-manifest.json"].sort();
  const actualEntries = readdirSync(root).sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error("Release candidate contains unexpected or missing entries");
  }
  for (const directory of candidateDirectories) {
    const pathname = path.join(root, directory);
    if (lstatSync(pathname).isSymbolicLink() || !statSync(pathname).isDirectory()) {
      throw new Error("Release candidate artifact layout is invalid");
    }
  }
  const manifestPath = path.join(root, "candidate-manifest.json");
  if (lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile()) {
    throw new Error("Release candidate manifest is invalid");
  }
}

function requireExactDirectoryEntries(root, expectedEntries, errorMessage) {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    throw new Error(errorMessage);
  }
  const actualEntries = readdirSync(root).sort();
  const expected = [...expectedEntries].sort();
  if (
    actualEntries.length !== expected.length ||
    actualEntries.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(errorMessage);
  }
}

export function hashArtifactDirectory(root) {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const files = listRegularFiles(root);
  for (const absolutePath of files) {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const contents = readFileSync(absolutePath);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(String(contents.byteLength));
    digest.update("\0");
    digest.update(contents);
    digest.update("\0");
    sizeBytes += contents.byteLength;
  }
  return {
    fileCount: files.length,
    sha256: digest.digest("hex"),
    sizeBytes,
  };
}

function validateArtifact(value, expectedPath, name) {
  const artifact = requireExactKeys(value, ["fileCount", "path", "sha256", "sizeBytes"], name);
  if (artifact.path !== expectedPath) {
    throw new Error(`${name}.path is invalid`);
  }
  return {
    fileCount: requireSafeInteger(artifact.fileCount, `${name}.fileCount`),
    path: expectedPath,
    sha256: requirePattern(artifact.sha256, digestPattern, `${name}.sha256`),
    sizeBytes: requireSafeInteger(artifact.sizeBytes, `${name}.sizeBytes`),
  };
}

function manifestIdentity(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    policyVersion: manifest.policyVersion,
    releaseVersion: manifest.releaseVersion,
    commitSha: manifest.commitSha,
    artifacts: manifest.artifacts,
    runpodWorker: manifest.runpodWorker,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateIdFor(manifest) {
  return createHash("sha256")
    .update(canonicalJson(manifestIdentity(manifest)))
    .digest("hex");
}

export function validateReleaseCandidateManifest(value) {
  const manifest = requireExactKeys(
    value,
    [
      "artifacts",
      "candidateId",
      "commitSha",
      "policyVersion",
      "releaseVersion",
      "runpodWorker",
      "schemaVersion",
    ],
    "Release candidate manifest",
  );
  if (manifest.schemaVersion !== candidateSchemaVersion) {
    throw new Error("Release candidate schema version is invalid");
  }
  if (manifest.policyVersion !== candidatePolicyVersion) {
    throw new Error("Release candidate policy version is invalid");
  }
  const artifacts = requireExactKeys(
    manifest.artifacts,
    [
      "acceptanceFixtures",
      "migrations",
      "orchestrator",
      "pagesFunctions",
      "supplyChain",
      "webAssets",
    ],
    "Release candidate artifacts",
  );
  const runpodWorker = requireExactKeys(
    manifest.runpodWorker,
    ["digest", "image"],
    "Release candidate RunPod Worker",
  );
  const image = requirePattern(
    runpodWorker.image,
    imagePattern,
    "Release candidate RunPod Worker image",
  );
  const imageMatch = imagePattern.exec(image);
  if (imageMatch?.[2] === undefined || runpodWorker.digest !== imageMatch[2]) {
    throw new Error("Release candidate RunPod Worker digest does not match its image");
  }

  const normalized = {
    schemaVersion: candidateSchemaVersion,
    policyVersion: candidatePolicyVersion,
    releaseVersion: requirePattern(
      manifest.releaseVersion,
      releaseVersionPattern,
      "Release candidate version",
    ),
    commitSha: requirePattern(manifest.commitSha, commitShaPattern, "Release candidate commit"),
    artifacts: {
      acceptanceFixtures: validateArtifact(
        artifacts.acceptanceFixtures,
        "acceptance-fixtures",
        "Release candidate acceptance fixtures",
      ),
      webAssets: validateArtifact(
        artifacts.webAssets,
        "web-assets",
        "Release candidate Web assets",
      ),
      pagesFunctions: validateArtifact(
        artifacts.pagesFunctions,
        "pages-functions",
        "Release candidate Pages Functions",
      ),
      supplyChain: validateArtifact(
        artifacts.supplyChain,
        "supply-chain",
        "Release candidate supply-chain evidence",
      ),
      orchestrator: validateArtifact(
        artifacts.orchestrator,
        "orchestrator",
        "Release candidate Orchestrator",
      ),
      migrations: validateArtifact(
        artifacts.migrations,
        "migrations",
        "Release candidate migrations",
      ),
    },
    runpodWorker: {
      image,
      digest: requirePattern(
        runpodWorker.digest,
        digestPattern,
        "Release candidate RunPod Worker digest",
      ),
    },
    candidateId: requirePattern(manifest.candidateId, digestPattern, "Release candidate ID"),
  };
  if (normalized.candidateId !== candidateIdFor(normalized)) {
    throw new Error("Release candidate ID does not match its manifest");
  }
  return normalized;
}

function artifactManifest(candidateRoot, relativePath) {
  return {
    path: relativePath,
    ...hashArtifactDirectory(path.join(candidateRoot, relativePath)),
  };
}

function readRunpodImageReference(pathname) {
  const value = readFileSync(pathname, "utf8").trim();
  const match = imagePattern.exec(value);
  if (match?.[2] === undefined) {
    throw new Error("RunPod Worker image evidence is invalid");
  }
  return {
    image: value,
    digest: match[2],
  };
}

function invalidOrchestratorModule(reason) {
  return new Error(`Orchestrator artifact must be a raw JavaScript module (${reason})`);
}

function validateOrchestratorModule(pathname) {
  if (
    !existsSync(pathname) ||
    lstatSync(pathname).isSymbolicLink() ||
    !statSync(pathname).isFile()
  ) {
    throw invalidOrchestratorModule("missing or not a regular file");
  }

  const bytes = readFileSync(pathname);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidOrchestratorModule("invalid UTF-8");
  }

  const trimmed = source.trim();
  const hasMultipartHeaders = /(?:^|\r?\n)Content-Disposition:\s*form-data;/iu.test(source);
  const hasDefaultExport =
    /\bexport\s*default\b/u.test(source) ||
    /\bexport\s*\{[^{}]*\bas\s+default\b[^{}]*\}/u.test(source);
  if (trimmed.length === 0) {
    throw invalidOrchestratorModule("empty file");
  }
  if (bytes.includes(0)) {
    throw invalidOrchestratorModule("NUL byte");
  }
  if (/^--[^\r\n]+\r?\n/u.test(trimmed) || hasMultipartHeaders) {
    throw invalidOrchestratorModule("multipart upload envelope");
  }
  if (!hasDefaultExport) {
    throw invalidOrchestratorModule("missing default export");
  }
}

function validatePagesFunctionsModule(pathname) {
  if (
    !existsSync(pathname) ||
    lstatSync(pathname).isSymbolicLink() ||
    !statSync(pathname).isFile() ||
    statSync(pathname).size === 0
  ) {
    throw new Error("Pages Functions artifact is missing or invalid");
  }
}

function copyDirectory(source, destination) {
  if (
    !existsSync(source) ||
    lstatSync(source).isSymbolicLink() ||
    !statSync(source).isDirectory()
  ) {
    throw new Error("Candidate build input directory is missing");
  }
  cpSync(source, destination, {
    dereference: false,
    errorOnExist: true,
    recursive: true,
  });
}

export function validateCandidateApplicationBuild(input) {
  hashArtifactDirectory(path.join(input.repositoryRoot, "apps", "web", "dist"));
  validatePagesFunctionsModule(
    path.join(input.repositoryRoot, "apps", "web", ".wrangler", "functions-build", "index.js"),
  );
  validateOrchestratorModule(path.join(input.orchestratorBundleDirectory, "index.js"));
}

export function verifyCandidateApplicationArtifact(root) {
  requireExactDirectoryEntries(
    root,
    candidateApplicationDirectories,
    "Candidate application artifact layout is invalid",
  );
  for (const directory of candidateApplicationDirectories) {
    const pathname = path.join(root, directory);
    if (lstatSync(pathname).isSymbolicLink() || !statSync(pathname).isDirectory()) {
      throw new Error("Candidate application artifact layout is invalid");
    }
  }
  requireExactDirectoryEntries(
    path.join(root, "orchestrator"),
    ["index.js"],
    "Candidate application Orchestrator layout is invalid",
  );
  requireExactDirectoryEntries(
    path.join(root, "pages-functions"),
    ["_worker.js"],
    "Candidate application Pages Functions layout is invalid",
  );
  hashArtifactDirectory(path.join(root, "web-assets"));
  validatePagesFunctionsModule(path.join(root, "pages-functions", "_worker.js"));
  validateOrchestratorModule(path.join(root, "orchestrator", "index.js"));
}

export function createCandidateApplicationArtifact(input) {
  if (existsSync(input.outputDirectory)) {
    throw new Error("Candidate application output directory already exists");
  }
  validateCandidateApplicationBuild(input);

  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o755 });
  copyDirectory(
    path.join(input.repositoryRoot, "apps", "web", "dist"),
    path.join(input.outputDirectory, "web-assets"),
  );
  mkdirSync(path.join(input.outputDirectory, "pages-functions"));
  copyFileSync(
    path.join(input.repositoryRoot, "apps", "web", ".wrangler", "functions-build", "index.js"),
    path.join(input.outputDirectory, "pages-functions", "_worker.js"),
  );
  mkdirSync(path.join(input.outputDirectory, "orchestrator"));
  copyFileSync(
    path.join(input.orchestratorBundleDirectory, "index.js"),
    path.join(input.outputDirectory, "orchestrator", "index.js"),
  );
  verifyCandidateApplicationArtifact(input.outputDirectory);
}

export function createReleaseCandidate(input) {
  if (existsSync(input.outputDirectory)) {
    throw new Error("Release candidate output directory already exists");
  }
  const packageManifest = requireRecord(
    JSON.parse(readFileSync(path.join(input.repositoryRoot, "package.json"), "utf8")),
    "Root package manifest",
  );
  const releaseVersion = requirePattern(
    packageManifest.version,
    releaseVersionPattern,
    "Root package version",
  );
  const commitSha = requirePattern(input.commitSha, commitShaPattern, "Release candidate commit");
  verifyCandidateApplicationArtifact(input.applicationArtifactDirectory);

  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o755 });
  for (const directory of candidateApplicationDirectories) {
    copyDirectory(
      path.join(input.applicationArtifactDirectory, directory),
      path.join(input.outputDirectory, directory),
    );
  }
  copyDirectory(
    path.join(input.repositoryRoot, "migrations"),
    path.join(input.outputDirectory, "migrations"),
  );
  copyDirectory(
    input.acceptanceFixtureDirectory,
    path.join(input.outputDirectory, "acceptance-fixtures"),
  );
  copyDirectory(input.supplyChainDirectory, path.join(input.outputDirectory, "supply-chain"));

  const partialManifest = {
    schemaVersion: candidateSchemaVersion,
    policyVersion: candidatePolicyVersion,
    releaseVersion,
    commitSha,
    artifacts: {
      acceptanceFixtures: artifactManifest(input.outputDirectory, "acceptance-fixtures"),
      webAssets: artifactManifest(input.outputDirectory, "web-assets"),
      pagesFunctions: artifactManifest(input.outputDirectory, "pages-functions"),
      supplyChain: artifactManifest(input.outputDirectory, "supply-chain"),
      orchestrator: artifactManifest(input.outputDirectory, "orchestrator"),
      migrations: artifactManifest(input.outputDirectory, "migrations"),
    },
    runpodWorker: readRunpodImageReference(input.runpodImageReferencePath),
  };
  const manifest = validateReleaseCandidateManifest({
    ...partialManifest,
    candidateId: candidateIdFor(partialManifest),
  });
  writeFileSync(
    path.join(input.outputDirectory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o644,
    },
  );
  return manifest;
}

export function verifyReleaseCandidate(input) {
  verifyCandidateLayout(input.candidateDirectory);
  validateOrchestratorModule(path.join(input.candidateDirectory, "orchestrator", "index.js"));
  const manifest = validateReleaseCandidateManifest(
    JSON.parse(
      readFileSync(path.join(input.candidateDirectory, "candidate-manifest.json"), "utf8"),
    ),
  );
  if (input.expectedCommitSha !== undefined && manifest.commitSha !== input.expectedCommitSha) {
    throw new Error("Release candidate commit does not match the expected commit");
  }
  if (
    input.expectedReleaseVersion !== undefined &&
    manifest.releaseVersion !== input.expectedReleaseVersion
  ) {
    throw new Error("Release candidate version does not match the expected version");
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    const actual = hashArtifactDirectory(path.join(input.candidateDirectory, artifact.path));
    if (
      actual.sha256 !== artifact.sha256 ||
      actual.fileCount !== artifact.fileCount ||
      actual.sizeBytes !== artifact.sizeBytes
    ) {
      throw new Error(`Release candidate artifact verification failed: ${artifact.path}`);
    }
  }
  return manifest;
}
