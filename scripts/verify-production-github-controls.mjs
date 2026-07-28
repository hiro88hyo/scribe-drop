import { spawnSync } from "node:child_process";

import { verifyProductionGithubControls } from "./production-github-controls.mjs";

const repositoryPattern =
  /github\.com(?::|\/)(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u;

function run(command, arguments_, label) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`${label} is unavailable`);
  }
  return result.stdout.trim();
}

function githubJson(repository, path, jq, label) {
  const endpoint = path.length === 0 ? `repos/${repository}` : `repos/${repository}/${path}`;
  const output = run("gh", ["api", endpoint, "--jq", jq], label);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} response is invalid`);
  }
}

try {
  const remote = run("git", ["remote", "get-url", "origin"], "Git origin");
  const repository = repositoryPattern.exec(remote)?.groups?.repository;
  if (repository === undefined) {
    throw new Error("GitHub repository identity is invalid");
  }
  const apiFailures = [];
  function githubJsonOr(path, jq, label, fallback) {
    try {
      return githubJson(repository, path, jq, label);
    } catch {
      apiFailures.push(`${label} is unavailable`);
      return fallback;
    }
  }
  const repositoryIdentity = githubJsonOr(
    "",
    "{defaultBranch:.default_branch}",
    "GitHub repository",
    {},
  );
  const defaultBranch =
    typeof repositoryIdentity.defaultBranch === "string" ? repositoryIdentity.defaultBranch : "";
  const releaseBranch = run("git", ["branch", "--show-current"], "Release branch");
  const branchProtections = Object.fromEntries(
    ["main", "develop", releaseBranch].map((branch) => [
      branch,
      githubJsonOr(
        `branches/${encodeURIComponent(branch)}/protection`,
        ".",
        `${branch} branch protection`,
        null,
      ),
    ]),
  );
  const workflowIdentity = githubJsonOr(
    "contents/.github/workflows/deploy-production-candidate.yml?ref=develop",
    "{workflowPath:.path}",
    "Production workflow registration",
    {},
  );
  const environment = githubJsonOr(
    "environments/production",
    "{name,protection_rules,deployment_branch_policy}",
    "Production GitHub Environment",
    {},
  );
  const branchPolicyNames = githubJsonOr(
    "environments/production/deployment-branch-policies?per_page=100",
    "[.branch_policies[].name]",
    "Production Environment branch policies",
    [],
  );
  const variableNames = githubJsonOr(
    "environments/production/variables?per_page=100",
    "[.variables[].name]",
    "Production Environment variables",
    [],
  );
  const secretNames = githubJsonOr(
    "environments/production/secrets?per_page=100",
    "[.secrets[].name]",
    "Production Environment secrets",
    [],
  );
  let result;
  try {
    result = verifyProductionGithubControls({
      branchProtections,
      branchPolicyNames,
      defaultBranch,
      environment,
      releaseBranch,
      secretNames,
      variableNames,
      workflowPath: workflowIdentity.workflowPath,
    });
  } catch (error) {
    const validationFailure =
      error instanceof Error ? error.message : "Production GitHub controls are invalid";
    throw new Error([...new Set([...apiFailures, validationFailure])].join("; "), {
      cause: error,
    });
  }
  if (apiFailures.length > 0) {
    throw new Error([...new Set(apiFailures)].join("; "));
  }
  console.log(
    `Verified production GitHub controls (${result.branchProtectionCount} protected branches, ${result.variableCount} variables, ${result.secretCount} secrets).`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Production GitHub controls verification failed",
  );
  process.exitCode = 1;
}
