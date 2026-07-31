import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { promotePagesCandidate, readPagesPromotionState } from "./pages-promotion.mjs";

const [outputDirectory] = process.argv.slice(2);
const configPath = path.resolve("apps", "web", ".wrangler", "deploy", "wrangler.toml");

function runDeploy(directory) {
  const result = spawnSync(
    path.resolve("node_modules", ".bin", "wrangler"),
    [
      "pages",
      "deploy",
      directory,
      "--cwd",
      "apps/web",
      "--project-name",
      process.env["SCRIBE_DROP_STAGING_PAGES_PROJECT"],
      "--branch",
      "develop",
      "--commit-hash",
      process.env["GITHUB_SHA"],
      "--commit-message",
      `release candidate ${String(process.env["GITHUB_SHA"] ?? "")}`,
      "--commit-dirty=false",
      "--no-bundle",
    ],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5 * 60_000,
    },
  );
  if (result.status !== 0) {
    throw new Error("Wrangler Pages deployment failed");
  }
}

try {
  if (outputDirectory === undefined || process.argv.length !== 3) {
    throw new Error("Usage: promote-pages-candidate <pages-output-directory>");
  }
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    !String(process.env["GITHUB_WORKFLOW_REF"] ?? "").includes("/deploy-staging-candidate.yml@")
  ) {
    throw new Error("Pages candidate promotion workflow identity is invalid");
  }
  const input = {
    accountId: process.env["CLOUDFLARE_ACCOUNT_ID"],
    apiToken: process.env["CLOUDFLARE_API_TOKEN"],
    branch: "develop",
    commitSha: process.env["GITHUB_SHA"],
    configContents: readFileSync(configPath, "utf8"),
    projectName: process.env["SCRIBE_DROP_STAGING_PAGES_PROJECT"],
  };
  const readState = () => readPagesPromotionState(input);
  const result = await promotePagesCandidate(
    { outputDirectory: path.resolve(outputDirectory) },
    {
      deploy({ outputDirectory: directory }) {
        runDeploy(directory);
      },
      onReadRetry({ attempt, maximumAttempts }) {
        console.warn(
          `Waiting for read-only Pages control-plane convergence (${String(attempt)}/${String(
            maximumAttempts,
          )})`,
        );
      },
      readState,
    },
  );
  console.log(
    `Verified staging Pages candidate promotion (${result.changed ? "updated" : "unchanged"}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pages candidate promotion failed");
  process.exitCode = 1;
}
