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
const target = process.argv[2];
const allowedTargets = new Set(["all", "orchestrator", "web"]);
if (target === undefined || !allowedTargets.has(target)) {
  throw new Error("Expected config target: all, orchestrator, or web");
}
const identifiers = {
  accessAudience: process.env.SCRIBE_DROP_STAGING_ACCESS_AUDIENCE,
  accessTeamDomain: process.env.SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  d1DatabaseId: process.env.SCRIBE_DROP_STAGING_D1_DATABASE_ID,
};

const configs = [
  {
    output: path.join(orchestratorOutputDirectory, "orchestrator-staging.toml"),
    render: renderOrchestratorStagingConfig,
    target: "orchestrator",
    template: path.join(repositoryRoot, "apps", "orchestrator", "wrangler.toml"),
  },
  {
    output: path.join(webOutputDirectory, "wrangler.toml"),
    render: renderWebStagingConfig,
    target: "web",
    template: path.join(repositoryRoot, "apps", "web", "wrangler.toml"),
  },
];

try {
  const selectedConfigs = configs.filter((config) => target === "all" || config.target === target);
  const selectedDirectories = new Set(selectedConfigs.map((config) => path.dirname(config.output)));
  for (const outputDirectory of selectedDirectories) {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    chmodSync(outputDirectory, 0o700);
  }

  for (const config of selectedConfigs) {
    const rendered = config.render(readFileSync(config.template, "utf8"), identifiers);
    writeFileSync(config.output, rendered, { encoding: "utf8", mode: 0o600 });
    chmodSync(config.output, 0o600);
  }

  if (target === "all" || target === "web") {
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
  }

  console.log(`Generated ignored Cloudflare staging config: ${target}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to render staging configs");
  process.exitCode = 1;
}
