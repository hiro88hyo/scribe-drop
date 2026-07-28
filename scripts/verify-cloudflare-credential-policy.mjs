import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyCloudflareCredentialPolicy } from "./cloudflare-credential-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const policy = JSON.parse(
  readFileSync(path.join(repositoryRoot, "tools", "cloudflare-credential-policy.json"), "utf8"),
);
const documentation = readFileSync(
  path.join(repositoryRoot, "docs", "cloudflare-permissions.md"),
  "utf8",
);
const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const workflows = readdirSync(workflowsDirectory)
  .filter((filename) => filename.endsWith(".yml") || filename.endsWith(".yaml"))
  .sort()
  .map((filename) => readFileSync(path.join(workflowsDirectory, filename), "utf8"))
  .join("\n");

function collectCloudflareApiFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".wrangler" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
    if (
      relativePath === "scripts/verify-ci-workflows.mjs" ||
      relativePath === "scripts/verify-cloudflare-credential-policy.mjs"
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectCloudflareApiFiles(absolutePath));
      continue;
    }
    const source = /\.(?:[cm]?js|tsx?)$/u.test(entry.name)
      ? readFileSync(absolutePath, "utf8")
      : "";
    if (
      source.includes("api.cloudflare.com/client/v4/accounts/") &&
      /\bfetch[A-Za-z]*\s*\(/u.test(source)
    ) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

try {
  const result = verifyCloudflareCredentialPolicy(policy, {
    cloudflareApiFiles: [
      ...collectCloudflareApiFiles(path.join(repositoryRoot, "apps")),
      ...collectCloudflareApiFiles(path.join(repositoryRoot, "scripts")),
    ].sort(),
    documentation,
    workflows,
  });
  console.log(
    `Cloudflare credential policy verified: ${String(result.credentialRoles)} roles, ${String(
      result.apiTokenRoles,
    )} API token roles, ${String(result.cloudflareApiFiles)} direct API files, ${String(
      result.wranglerCommands,
    )} workflow commands`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloudflare credential policy failed");
  process.exitCode = 1;
}
