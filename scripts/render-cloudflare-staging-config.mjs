import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  renderOrchestratorStagingConfig,
  renderWebStagingConfig,
} from "./cloudflare-staging-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const orchestratorOutputDirectory = path.join(repositoryRoot, ".wrangler", "deploy");
const webOutputDirectory = path.join(repositoryRoot, "apps", "web", ".wrangler", "deploy");
const webFunctionsLink = path.join(webOutputDirectory, "functions");
const webFunctionsTarget = "../../functions";
const identifiers = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  d1DatabaseId: process.env.SCRIBE_DROP_STAGING_D1_DATABASE_ID,
};

const configs = [
  {
    output: path.join(orchestratorOutputDirectory, "orchestrator-staging.toml"),
    render: renderOrchestratorStagingConfig,
    template: path.join(repositoryRoot, "apps", "orchestrator", "wrangler.toml"),
  },
  {
    output: path.join(webOutputDirectory, "wrangler.toml"),
    render: renderWebStagingConfig,
    template: path.join(repositoryRoot, "apps", "web", "wrangler.toml"),
  },
];

try {
  for (const outputDirectory of [orchestratorOutputDirectory, webOutputDirectory]) {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    chmodSync(outputDirectory, 0o700);
  }

  for (const config of configs) {
    const rendered = config.render(readFileSync(config.template, "utf8"), identifiers);
    writeFileSync(config.output, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(config.output, 0o600);
  }

  try {
    const linkStats = lstatSync(webFunctionsLink);
    if (!linkStats.isSymbolicLink() || readlinkSync(webFunctionsLink) !== webFunctionsTarget) {
      throw new Error("web staging functions link exists with an unexpected target");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      symlinkSync(webFunctionsTarget, webFunctionsLink, "dir");
    } else {
      throw error;
    }
  }

  console.log("Generated ignored Cloudflare staging configs");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to render staging configs");
  process.exitCode = 1;
}
