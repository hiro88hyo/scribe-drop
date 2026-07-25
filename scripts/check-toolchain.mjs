import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const toolVersions = JSON.parse(
  readFileSync(path.join(repositoryRoot, "tools", "versions.json"), "utf8"),
);

const failures = [];

function execute(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error ? String(error.stderr).trim() : String(error);
    failures.push(`${command}: 実行できません (${detail || "unknown error"})`);
    return "";
  }
}

function expectVersion(label, actualOutput, expected) {
  const match = actualOutput.match(/\d+\.\d+(?:\.\d+)?/u);
  const actual = match?.[0] ?? "";

  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, got ${actual || JSON.stringify(actualOutput)}`);
    return;
  }

  console.log(`${label}: ${actual}`);
}

function expectVersionPrefix(label, actualOutput, expected) {
  const match = actualOutput.match(/\d+\.\d+(?:\.\d+)?/u);
  const actual = match?.[0] ?? "";

  if (actual !== expected && !actual.startsWith(`${expected}.`)) {
    failures.push(
      `${label}: expected ${expected}.x, got ${actual || JSON.stringify(actualOutput)}`,
    );
    return;
  }

  console.log(`${label}: ${actual}`);
}

expectVersion("Volta", execute("volta", ["--version"]), toolVersions.volta);
expectVersion("Node.js", process.versions.node, packageJson.volta.node);
expectVersion("pnpm", execute("pnpm", ["--version"]), packageJson.volta.pnpm);
expectVersion("uv", execute("uv", ["--version"]), toolVersions.uv);
expectVersionPrefix(
  "Python",
  execute("uv", ["run", "--no-project", "--python", toolVersions.python, "python", "--version"]),
  toolVersions.python,
);
expectVersion(
  "Wrangler",
  execute("pnpm", ["exec", "wrangler", "--version"]),
  packageJson.devDependencies.wrangler,
);

const gitleaksExecutable =
  process.platform === "win32"
    ? path.join(repositoryRoot, ".tools", "bin", "gitleaks.exe")
    : path.join(repositoryRoot, ".tools", "bin", "gitleaks");
expectVersion("Gitleaks", execute(gitleaksExecutable, ["version"]), toolVersions.gitleaks.version);

const runpodctlExecutable =
  process.platform === "win32"
    ? path.join(repositoryRoot, ".tools", "bin", "runpodctl.exe")
    : path.join(repositoryRoot, ".tools", "bin", "runpodctl");
expectVersion(
  "runpodctl",
  execute(runpodctlExecutable, ["version"]),
  toolVersions.runpodctl.version,
);

if (process.env.VOLTA_FEATURE_PNPM !== "1") {
  failures.push("VOLTA_FEATURE_PNPM: expected 1");
} else {
  console.log("VOLTA_FEATURE_PNPM: 1");
}

if (failures.length > 0) {
  console.error("\nToolchain check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("\nToolchain check passed.");
}
