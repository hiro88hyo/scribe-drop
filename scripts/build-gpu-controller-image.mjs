import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "scribe-drop-controller-image-"));
const deploymentWorkspace = path.join(temporaryRoot, "workspace");
const buildContext = path.join(temporaryRoot, "bundle");
const modulesStatePath = path.join(repositoryRoot, "node_modules", ".modules.yaml");
const modulesStateBefore = existsSync(modulesStatePath)
  ? readFileSync(modulesStatePath)
  : undefined;

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("GPU controller image preparation failed");
  }
}

function copyDeploymentProject(relativePath) {
  const source = path.join(repositoryRoot, relativePath);
  const target = path.join(deploymentWorkspace, relativePath);
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(source, "package.json"), path.join(target, "package.json"));
  const sourceDistribution = path.join(source, "dist");
  cpSync(sourceDistribution, path.join(target, "dist"), {
    filter: (sourcePath) => {
      const metadata = lstatSync(sourcePath);
      return metadata.isDirectory() || (metadata.isFile() && sourcePath.endsWith(".js"));
    },
    recursive: true,
  });
}

try {
  run("pnpm", ["--filter", "@scribe-drop/gpu-controller^...", "build"]);
  run("pnpm", ["--filter", "@scribe-drop/gpu-controller", "build"]);
  mkdirSync(deploymentWorkspace, { recursive: true });
  for (const filename of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    copyFileSync(path.join(repositoryRoot, filename), path.join(deploymentWorkspace, filename));
  }
  for (const project of ["apps/gpu-controller", "packages/contracts", "packages/domain"]) {
    copyDeploymentProject(project);
  }
  run(
    "pnpm",
    ["--filter", "@scribe-drop/gpu-controller", "deploy", "--prod", "--legacy", buildContext],
    deploymentWorkspace,
  );
  run("docker", [
    "buildx",
    "build",
    "--load",
    "--platform",
    "linux/amd64",
    "--tag",
    "scribe-drop-gpu-controller:local",
    "--file",
    path.join(repositoryRoot, "apps", "gpu-controller", "Dockerfile"),
    buildContext,
  ]);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
const modulesStateAfter = existsSync(modulesStatePath) ? readFileSync(modulesStatePath) : undefined;
if (
  modulesStateBefore?.equals(modulesStateAfter) !== true &&
  (modulesStateBefore !== undefined || modulesStateAfter !== undefined)
) {
  throw new Error("GPU controller image preparation changed workspace install state");
}
