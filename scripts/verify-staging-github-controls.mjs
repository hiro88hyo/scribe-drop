import { spawnSync } from "node:child_process";

import { verifyStagingGithubControls } from "./staging-github-controls.mjs";

const repositoryPattern =
  /github\.com(?::|\/)(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u;

function run(command, arguments_, label) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${label} is unavailable`);
  return result.stdout.trim();
}

function githubJson(repository, path, jq, label) {
  const endpoint = path.length === 0 ? `repos/${repository}` : `repos/${repository}/${path}`;
  try {
    return JSON.parse(run("gh", ["api", endpoint, "--jq", jq], label));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} response is invalid`, { cause: error });
    }
    throw error;
  }
}

try {
  const remote = run("git", ["remote", "get-url", "origin"], "Git origin");
  const repository = repositoryPattern.exec(remote)?.groups?.repository;
  if (repository === undefined) throw new Error("GitHub repository identity is invalid");
  const releaseBranch = run("git", ["branch", "--show-current"], "Release branch");
  const repositoryIdentity = githubJson(
    repository,
    "",
    "{defaultBranch:.default_branch}",
    "GitHub repository",
  );
  const branchProtections = Object.fromEntries(
    ["main", "develop", releaseBranch].map((branch) => [
      branch,
      githubJson(
        repository,
        `branches/${encodeURIComponent(branch)}/protection`,
        ".",
        `${branch} branch protection`,
      ),
    ]),
  );
  const result = verifyStagingGithubControls({
    branchProtections,
    branchPolicyNames: githubJson(
      repository,
      "environments/staging/deployment-branch-policies?per_page=100",
      "[.branch_policies[].name]",
      "Staging Environment branch policies",
    ),
    defaultBranch: repositoryIdentity.defaultBranch,
    environment: githubJson(
      repository,
      "environments/staging",
      "{name,protection_rules,deployment_branch_policy}",
      "Staging GitHub Environment",
    ),
    releaseBranch,
    secretNames: githubJson(
      repository,
      "environments/staging/secrets?per_page=100",
      "[.secrets[].name]",
      "Staging Environment secrets",
    ),
    variableNames: githubJson(
      repository,
      "environments/staging/variables?per_page=100",
      "[.variables[].name]",
      "Staging Environment variables",
    ),
    workflowPath: githubJson(
      repository,
      "contents/.github/workflows/deploy-staging-candidate.yml?ref=develop",
      "{workflowPath:.path}",
      "Staging workflow registration",
    ).workflowPath,
  });
  console.log(
    `Verified staging GitHub controls (${result.branchProtectionCount} protected branches, ${result.variableCount} variables, ${result.secretCount} secrets).`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Staging GitHub controls verification failed",
  );
  process.exitCode = 1;
}
