import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const actionReferencePattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu;
const usesPattern = /^\s*uses:\s*(\S+)/gmu;
const failures = [];
let actionReferenceCount = 0;

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
