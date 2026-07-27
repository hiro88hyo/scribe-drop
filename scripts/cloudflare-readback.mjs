import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function countOccurrences(value, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function requireOnce(value, needle, name) {
  if (countOccurrences(value, needle) !== 1) {
    throw new Error(`Cloudflare ${name} read-back does not match`);
  }
}

function parseSingleCorsRule(value) {
  const fields = new Map();
  for (const line of value.split(/\r?\n/u)) {
    const match = /^([a-z_]+):\s+(.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      if (fields.has(match[1])) {
        throw new Error("Cloudflare R2 CORS read-back contains multiple rules");
      }
      fields.set(match[1], match[2]);
    }
  }
  return fields;
}

function commaSeparatedSet(value) {
  return new Set(value.split(",").map((entry) => entry.trim()));
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function verifyCloudflareReadback(outputs, expected) {
  const projects = JSON.parse(outputs.projects);
  const matchingProjects = Array.isArray(projects)
    ? projects.filter((project) => project?.["Project Name"] === expected.pagesProjectName)
    : [];
  if (matchingProjects.length !== 1 || matchingProjects[0]?.["Git Provider"] !== "No") {
    throw new Error("Cloudflare Pages project must disable Git-provider automatic deployments");
  }
  if (expected.commitSha !== undefined) {
    const pagesDeployments = JSON.parse(outputs.pagesDeployments);
    const latestPagesDeployment = Array.isArray(pagesDeployments) ? pagesDeployments[0] : undefined;
    if (
      latestPagesDeployment?.Environment !== "Production" ||
      latestPagesDeployment?.Branch !== expected.pagesBranch ||
      latestPagesDeployment?.Source !== expected.commitSha.slice(0, 7)
    ) {
      throw new Error("Cloudflare Pages candidate deployment read-back does not match");
    }
    const pagesProject = JSON.parse(outputs.pagesProject);
    if (
      pagesProject?.name !== expected.pagesProjectName ||
      pagesProject?.production_branch !== expected.pagesBranch ||
      pagesProject?.deployment_configs?.production?.wrangler_config_hash !==
        expected.pagesConfigHash
    ) {
      throw new Error("Cloudflare Pages deployed configuration read-back does not match");
    }

    const deployment = JSON.parse(outputs.workerDeployment);
    if (
      deployment?.strategy !== "percentage" ||
      !Array.isArray(deployment.versions) ||
      deployment.versions.length !== 1 ||
      deployment.versions[0]?.percentage !== 100
    ) {
      throw new Error("Cloudflare Worker candidate is not the sole active version");
    }
    const activeVersionId = deployment.versions[0]?.version_id;
    const versions = JSON.parse(outputs.workerVersions);
    const activeCandidateVersion = Array.isArray(versions)
      ? versions.find((version) => version?.id === activeVersionId)
      : undefined;
    if (
      activeCandidateVersion?.annotations?.["workers/tag"] !== `candidate-${expected.commitSha}` ||
      activeCandidateVersion?.annotations?.["workers/message"] !==
        `release candidate ${expected.commitSha}`
    ) {
      throw new Error("Cloudflare Worker candidate version read-back does not match");
    }
    const version = JSON.parse(outputs.workerVersion);
    const bindings = version?.resources?.bindings;
    if (!Array.isArray(bindings)) {
      throw new Error("Cloudflare Worker binding read-back is invalid");
    }
    const bindingByName = new Map(bindings.map((binding) => [binding?.name, binding]));
    const expectedBindings = expected.bindings;
    if (
      bindingByName.size !== expectedBindings.size ||
      [...expectedBindings].some(([name, binding]) => {
        const actual = bindingByName.get(name);
        return (
          actual?.type !== binding.type ||
          (binding.text !== undefined && actual.text !== binding.text) ||
          (binding.bucketName !== undefined && actual.bucket_name !== binding.bucketName) ||
          (binding.databaseId !== undefined && actual.database_id !== binding.databaseId)
        );
      })
    ) {
      throw new Error("Cloudflare Worker binding read-back does not match");
    }
  }

  requireOnce(outputs.notification, "rule_id:", "R2 notification count");
  requireOnce(outputs.notification, `queue_name:  ${expected.queueName}`, "R2 notification queue");
  requireOnce(outputs.notification, "prefix:      incoming/", "R2 notification prefix");
  requireOnce(outputs.notification, "suffix:      (all suffixes)", "R2 notification suffix");
  requireOnce(
    outputs.notification,
    "event_type:  PutObject,CompleteMultipartUpload,CopyObject",
    "R2 notification event types",
  );

  requireOnce(outputs.queue, `Queue Name: ${expected.queueName}`, "Queue name");
  requireOnce(outputs.queue, "Number of Producers: 1", "Queue producer count");
  requireOnce(outputs.queue, `Producers: r2_bucket:${expected.bucketName}`, "Queue producer");
  requireOnce(outputs.queue, "Number of Consumers: 1", "Queue consumer count");
  requireOnce(outputs.queue, `Consumers: worker:${expected.workerName}`, "Queue consumer");

  const consumers = JSON.parse(outputs.consumer);
  if (
    !Array.isArray(consumers) ||
    consumers.length !== 1 ||
    consumers[0]?.script !== expected.workerName ||
    consumers[0]?.dead_letter_queue !== expected.deadLetterQueueName ||
    consumers[0]?.type !== "worker" ||
    consumers[0]?.settings?.batch_size !== 10 ||
    consumers[0]?.settings?.max_retries !== 5 ||
    consumers[0]?.settings?.max_wait_time_ms !== 5_000 ||
    consumers[0]?.settings?.retry_delay !== 60
  ) {
    throw new Error("Cloudflare Queue consumer read-back does not match");
  }

  const corsFields = parseSingleCorsRule(outputs.cors);
  const corsRule = expected.cors.rules[0];
  if (
    expected.cors.rules.length !== 1 ||
    corsRule === undefined ||
    corsRule.allowed.origins.length !== 1 ||
    corsFields.get("allowed_origins") !== corsRule.allowed.origins[0] ||
    !setsEqual(
      commaSeparatedSet(corsFields.get("allowed_methods") ?? ""),
      new Set(corsRule.allowed.methods),
    ) ||
    !setsEqual(
      commaSeparatedSet(corsFields.get("allowed_headers") ?? ""),
      new Set(corsRule.allowed.headers),
    ) ||
    !setsEqual(
      commaSeparatedSet(corsFields.get("exposed_headers") ?? ""),
      new Set(corsRule.exposeHeaders),
    ) ||
    corsFields.get("max_age_seconds") !== String(corsRule.maxAgeSeconds)
  ) {
    throw new Error("Cloudflare R2 CORS read-back does not match");
  }

  if (
    !outputs.migrations.includes("No migrations to apply!") ||
    outputs.migrations.includes("Migrations to be applied")
  ) {
    throw new Error("Cloudflare D1 migrations are not fully applied");
  }

  if (!Array.isArray(expected.lifecycle.rules) || expected.lifecycle.rules.length !== 2) {
    throw new Error("Expected R2 lifecycle configuration is invalid");
  }
  for (const rule of expected.lifecycle.rules) {
    const lifecycleBlocks = outputs.lifecycle
      .split(/\r?\n\r?\n/u)
      .filter((block) => block.includes(`name:     ${rule.id}`));
    if (lifecycleBlocks.length !== 1 || lifecycleBlocks[0] === undefined) {
      throw new Error("Cloudflare R2 lifecycle rule read-back does not match");
    }
    const lifecycleBlock = lifecycleBlocks[0];
    requireOnce(lifecycleBlock, "enabled:  Yes", "R2 lifecycle enabled state");
    requireOnce(lifecycleBlock, `prefix:   ${rule.conditions.prefix}`, "R2 lifecycle prefix");
    const expirationDays = rule.deleteObjectsTransition.condition.maxAge / (24 * 60 * 60);
    requireOnce(
      lifecycleBlock,
      `Expire objects after ${String(expirationDays)} days`,
      "R2 lifecycle expiration",
    );
    if (rule.abortMultipartUploadsTransition !== undefined) {
      const abortDays = rule.abortMultipartUploadsTransition.condition.maxAge / (24 * 60 * 60);
      requireOnce(
        lifecycleBlock,
        `Abort incomplete multipart uploads after ${String(abortDays)} days`,
        "R2 multipart lifecycle",
      );
    }
  }
}

function runWrangler(arguments_) {
  const result = spawnSync(path.resolve("node_modules", ".bin", "wrangler"), arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler ${arguments_.slice(0, 3).join(" ")} read-back failed`);
  }
  return result.stdout;
}

async function fetchPagesProject(accountId, projectName) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (
    typeof accountId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(accountId) ||
    typeof apiToken !== "string" ||
    apiToken.length === 0
  ) {
    throw new Error("Cloudflare Pages read-back credentials are missing or invalid");
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error("Cloudflare Pages project configuration read-back failed");
  }
  const envelope = await response.json();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("success" in envelope) ||
    envelope.success !== true ||
    !("result" in envelope) ||
    typeof envelope.result !== "object" ||
    envelope.result === null
  ) {
    throw new Error("Cloudflare Pages project configuration read-back is invalid");
  }
  return JSON.stringify(envelope.result);
}

export async function runCloudflareReadback(input) {
  const suffix = input.environment;
  const configArguments = ["--config", input.configPath, "--env", input.environment];
  const bucketName = `recording-transcriber-${suffix}`;
  const queueName = `recording-uploaded-${suffix}`;
  const deadLetterQueueName = `recording-uploaded-dlq-${suffix}`;
  const workerName = `scribe-drop-orchestrator-${suffix}`;
  const pagesProjectName =
    process.env[`SCRIBE_DROP_${input.environment.toUpperCase()}_PAGES_PROJECT`];
  if (pagesProjectName !== `scribe-drop-web-${input.environment}`) {
    throw new Error("Cloudflare Pages project name is missing or invalid");
  }
  const expectedCommitSha = process.env.EXPECTED_COMMIT_SHA;
  if (expectedCommitSha !== undefined && !/^[0-9a-f]{40}$/u.test(expectedCommitSha)) {
    throw new Error("Expected deployment commit is invalid");
  }
  const workerArguments = ["--config", input.configPath, "--env", input.environment, "--json"];
  const outputs = {
    consumer: runWrangler(["queues", "consumer", "list", queueName, ...configArguments, "--json"]),
    cors: runWrangler(["r2", "bucket", "cors", "list", bucketName, ...configArguments]),
    lifecycle: runWrangler(["r2", "bucket", "lifecycle", "list", bucketName, ...configArguments]),
    migrations: runWrangler([
      "d1",
      "migrations",
      "list",
      "SCRIBE_DROP_DB",
      "--remote",
      ...configArguments,
    ]),
    notification: runWrangler([
      "r2",
      "bucket",
      "notification",
      "list",
      bucketName,
      ...configArguments,
    ]),
    pagesDeployments:
      expectedCommitSha === undefined
        ? "[]"
        : runWrangler([
            "pages",
            "deployment",
            "list",
            "--project-name",
            pagesProjectName,
            "--environment",
            "production",
            "--json",
          ]),
    pagesProject: "{}",
    projects: runWrangler(["pages", "project", "list", "--json"]),
    queue: runWrangler(["queues", "info", queueName, ...configArguments]),
    workerDeployment:
      expectedCommitSha === undefined
        ? "{}"
        : runWrangler(["deployments", "status", ...workerArguments]),
    workerVersion: "{}",
    workerVersions:
      expectedCommitSha === undefined
        ? "[]"
        : runWrangler(["versions", "list", ...workerArguments]),
  };
  if (expectedCommitSha !== undefined) {
    outputs.pagesProject = await fetchPagesProject(
      process.env.CLOUDFLARE_ACCOUNT_ID,
      pagesProjectName,
    );
    const versions = JSON.parse(outputs.workerVersions);
    const deployment = JSON.parse(outputs.workerDeployment);
    const activeVersionId =
      Array.isArray(deployment?.versions) &&
      deployment.versions.length === 1 &&
      deployment.versions[0]?.percentage === 100
        ? deployment.versions[0]?.version_id
        : undefined;
    const candidateVersion = Array.isArray(versions)
      ? versions.find(
          (version) =>
            version?.id === activeVersionId &&
            version?.annotations?.["workers/tag"] === `candidate-${expectedCommitSha}`,
        )
      : undefined;
    if (candidateVersion?.id === undefined) {
      throw new Error("Cloudflare Worker candidate version is missing");
    }
    outputs.workerVersion = runWrangler([
      "versions",
      "view",
      candidateVersion.id,
      ...workerArguments,
    ]);
  }
  const environmentPrefix = `SCRIBE_DROP_${input.environment.toUpperCase()}`;
  const retentionValue = (name, fallback) => {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
  };
  const expectedBindings = new Map([
    ["APP_ENV", { text: input.environment, type: "plain_text" }],
    [
      "AUDIT_RETENTION_DAYS",
      {
        text: retentionValue("AUDIT_RETENTION_DAYS", "180"),
        type: "plain_text",
      },
    ],
    ["CLOUDFLARE_ACCOUNT_ID", { text: process.env.CLOUDFLARE_ACCOUNT_ID, type: "plain_text" }],
    ["DISCORD_WEBHOOK_URL", { type: "secret_text" }],
    [
      "MULTIPART_RETENTION_HOURS",
      {
        text: retentionValue("MULTIPART_RETENTION_HOURS", "24"),
        type: "plain_text",
      },
    ],
    ["R2_ACCESS_KEY_ID", { type: "secret_text" }],
    ["R2_BUCKET_NAME", { text: bucketName, type: "plain_text" }],
    ["R2_SECRET_ACCESS_KEY", { type: "secret_text" }],
    ["RECORDINGS", { bucketName, type: "r2_bucket" }],
    [
      "RESULT_RETENTION_DAYS",
      {
        text: retentionValue("RESULT_RETENTION_DAYS", "90"),
        type: "plain_text",
      },
    ],
    ["RUNPOD_API_KEY", { type: "secret_text" }],
    ["RUNPOD_ENDPOINT_ID", { type: "secret_text" }],
    [
      "RUNPOD_INTERNAL_BASE_URL",
      {
        text: process.env[`${environmentPrefix}_ORCHESTRATOR_ORIGIN`],
        type: "plain_text",
      },
    ],
    ["SCRIBE_DROP_DB", { databaseId: input.d1DatabaseId, type: "d1" }],
    [
      "SOURCE_RETENTION_DAYS",
      {
        text: retentionValue("SOURCE_RETENTION_DAYS", "7"),
        type: "plain_text",
      },
    ],
    [
      "WEB_BASE_URL",
      {
        text: process.env[`${environmentPrefix}_WEB_ORIGIN`],
        type: "plain_text",
      },
    ],
  ]);
  verifyCloudflareReadback(outputs, {
    bucketName,
    bindings: expectedBindings,
    commitSha: expectedCommitSha,
    cors: JSON.parse(readFileSync(input.corsPath, "utf8")),
    deadLetterQueueName,
    lifecycle: JSON.parse(readFileSync(input.lifecyclePath, "utf8")),
    pagesConfigHash:
      expectedCommitSha === undefined
        ? undefined
        : createHash("sha256").update(readFileSync(input.pagesConfigPath)).digest("hex"),
    pagesProjectName,
    pagesBranch: input.environment === "staging" ? "develop" : "main",
    queueName,
    workerName,
  });
}
