const accountIdPattern = /^[0-9a-f]{32}$/u;
const accessAudiencePattern = /^[A-Za-z0-9_-]{1,256}$/u;
const serviceTokenCommonNamePattern = /^[A-Za-z0-9._-]{3,512}$/u;
const accessTeamDomainPattern =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const d1DatabaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const runpodGpuIdPattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,126}[A-Za-z0-9]$/u;
const runpodImagePattern =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/scribe-drop-runpod-worker@sha256:[0-9a-f]{64}$/u;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const stagingAcceptanceFaults = new Set([
  "notification_unavailable",
  "runtime_heartbeat_response_loss",
  "worker_disconnect_after_claim",
]);
const stagingAcceptanceFaultIdentifierKeys = [
  "acceptanceFault",
  "acceptanceFaultExpiresAt",
  "acceptanceFaultIssuedAt",
  "acceptanceFaultJobId",
];

const accountIdPlaceholder = "0".repeat(32);
const accessAudiencePlaceholder = "replace-with-access-audience";
const accessTeamDomainPlaceholder = "https://replace-with-team.cloudflareaccess.com";
const stagingE2eServiceTokenCommonNamePlaceholder = "replace-with-staging-e2e-service-token";
const stagingD1DatabaseIdPlaceholder = "00000000-0000-0000-0000-000000000101";
const stagingOrchestratorHostnamePlaceholder = "replace-with-staging-orchestrator.example.invalid";
const stagingOrchestratorOriginPlaceholder =
  "https://replace-with-staging-orchestrator.example.invalid";
const stagingCloudRunControllerOriginPlaceholder =
  "https://replace-with-staging-gpu-controller.example.invalid";
const stagingCloudRunOrchestratorOriginPlaceholder =
  "https://replace-with-staging-cloud-run-orchestrator.example.invalid";
const stagingCloudRunRuntimeServiceAccountPlaceholder =
  "replace-with-staging-runtime@replace-with-project.iam.gserviceaccount.com";
const webOriginPlaceholder = "https://replace-with-staging-web.example.invalid";
const productionD1DatabaseIdPlaceholder = "00000000-0000-0000-0000-000000000201";
const productionOrchestratorHostnamePlaceholder =
  "replace-with-production-orchestrator.example.invalid";
const productionOrchestratorOriginPlaceholder =
  "https://replace-with-production-orchestrator.example.invalid";
const productionCloudRunControllerOriginPlaceholder =
  "https://replace-with-production-gpu-controller.example.invalid";
const productionCloudRunOrchestratorOriginPlaceholder =
  "https://replace-with-production-cloud-run-orchestrator.example.invalid";
const productionCloudRunRuntimeServiceAccountPlaceholder =
  "replace-with-production-runtime@replace-with-project.iam.gserviceaccount.com";
const productionWebOriginPlaceholder = "https://replace-with-production-web.example.invalid";
const retentionDefaults = {
  auditRetentionDays: 180,
  multipartRetentionHours: 24,
  resultRetentionDays: 90,
  sourceRetentionDays: 7,
};
const runpodGpuIdsPlaceholder =
  "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition";
const runpodWorkerImagePlaceholder =
  "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "0".repeat(64);

function requireIdentifier(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or has an invalid format`);
  }

  return value;
}

function replaceOnce(source, searchValue, replacement, label) {
  const firstIndex = source.indexOf(searchValue);
  if (firstIndex === -1) {
    throw new Error(`${label} placeholder was not found`);
  }

  if (source.indexOf(searchValue, firstIndex + searchValue.length) !== -1) {
    throw new Error(`${label} placeholder is ambiguous`);
  }

  return `${source.slice(0, firstIndex)}${replacement}${source.slice(
    firstIndex + searchValue.length,
  )}`;
}

function requireExactHttpsOrigin(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} is missing or invalid`);
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error(`${name} is missing or invalid`);
  }

  return value;
}

function validatedStagingCloudRunConfiguration(identifiers, orchestratorOrigin) {
  const mode = identifiers.cloudRunRuntimeMode ?? "disabled";
  if (mode !== "disabled" && mode !== "synthetic-shadow") {
    throw new Error("SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_MODE is invalid");
  }
  if (mode === "disabled") {
    return { mode };
  }
  const controllerOrigin = requireExactHttpsOrigin(
    identifiers.cloudRunControllerOrigin,
    "SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN",
  );
  if (
    !/^scribe-drop-staging-gpu-controller-[0-9]+\.asia-southeast1\.run\.app$/u.test(
      new URL(controllerOrigin).hostname,
    )
  ) {
    throw new Error("SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN is invalid");
  }
  const runtimeServiceAccount = requireIdentifier(
    identifiers.cloudRunRuntimeServiceAccount,
    /^gpu-runtime@scribe-drop\.iam\.gserviceaccount\.com$/u,
    "SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
  );
  return { controllerOrigin, mode, orchestratorOrigin, runtimeServiceAccount };
}

function validatedStagingGpuExecutionPolicy(identifiers, cloudRun) {
  const policy = identifiers.gpuExecutionPolicy ?? "runpod_serverless_v1";
  if (!new Set(["runpod_serverless_v1", "cloud_run_jobs_l4_v1"]).has(policy)) {
    throw new Error("SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY is invalid");
  }
  if (policy === "cloud_run_jobs_l4_v1" && cloudRun.mode !== "synthetic-shadow") {
    throw new Error("Cloud Run execution requires the staging runtime service");
  }
  return policy;
}

function validatedGpuExecutionAdmission(identifiers, environment) {
  const admission = identifiers.gpuExecutionAdmission ?? "active";
  if (admission !== "active" && admission !== "paused") {
    throw new Error(`SCRIBE_DROP_${environment.toUpperCase()}_GPU_EXECUTION_ADMISSION is invalid`);
  }
  return admission;
}

function validatedProductionCloudRunConfiguration(identifiers, orchestratorOrigin) {
  const mode = identifiers.cloudRunRuntimeMode ?? "disabled";
  if (mode !== "disabled" && mode !== "active") {
    throw new Error("SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_MODE is invalid");
  }
  if (mode === "disabled") return { mode };
  const controllerOrigin = requireExactHttpsOrigin(
    identifiers.cloudRunControllerOrigin,
    "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_ORIGIN",
  );
  if (
    !/^scribe-drop-production-gpu-controller-[0-9]+\.asia-southeast1\.run\.app$/u.test(
      new URL(controllerOrigin).hostname,
    )
  ) {
    throw new Error("SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_ORIGIN is invalid");
  }
  const runtimeServiceAccount = requireIdentifier(
    identifiers.cloudRunRuntimeServiceAccount,
    /^gpu-runtime-production@scribe-drop\.iam\.gserviceaccount\.com$/u,
    "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
  );
  return { controllerOrigin, mode, orchestratorOrigin, runtimeServiceAccount };
}

function validatedProductionGpuExecutionPolicy(identifiers, cloudRun) {
  const policy = identifiers.gpuExecutionPolicy ?? "runpod_serverless_v1";
  if (!new Set(["runpod_serverless_v1", "cloud_run_jobs_l4_v1"]).has(policy)) {
    throw new Error("SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY is invalid");
  }
  if (policy === "cloud_run_jobs_l4_v1" && cloudRun.mode !== "active") {
    throw new Error("Cloud Run execution requires the production runtime service");
  }
  return policy;
}

export function validateStagingAcceptanceFaultIdentifiers(identifiers, cloudRunMode) {
  const values = stagingAcceptanceFaultIdentifierKeys.map((key) => identifiers[key]);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => typeof value !== "string") || cloudRunMode !== "synthetic-shadow") {
    throw new Error("Staging acceptance fault configuration is incomplete or unavailable");
  }
  if (!stagingAcceptanceFaults.has(identifiers.acceptanceFault)) {
    throw new Error("Staging acceptance fault is invalid");
  }
  const jobId = requireIdentifier(
    identifiers.acceptanceFaultJobId,
    ulidPattern,
    "STAGING_ACCEPTANCE_FAULT_JOB_ID",
  );
  const issuedAt = identifiers.acceptanceFaultIssuedAt;
  const expiresAt = identifiers.acceptanceFaultExpiresAt;
  const issuedMilliseconds = Date.parse(issuedAt);
  const expiresMilliseconds = Date.parse(expiresAt);
  if (
    !Number.isFinite(issuedMilliseconds) ||
    !Number.isFinite(expiresMilliseconds) ||
    new Date(issuedMilliseconds).toISOString() !== issuedAt ||
    new Date(expiresMilliseconds).toISOString() !== expiresAt ||
    expiresMilliseconds <= issuedMilliseconds ||
    expiresMilliseconds - issuedMilliseconds > 30 * 60 * 1_000
  ) {
    throw new Error("Staging acceptance fault lifetime is invalid");
  }
  return {
    expiresAt,
    fault: identifiers.acceptanceFault,
    issuedAt,
    jobId,
  };
}

function rejectEnvironmentMarker(value, marker, name) {
  if (value.toLowerCase().includes(marker)) {
    throw new Error(`${name} must not contain a ${marker} environment marker`);
  }
  return value;
}

function renderMigrationsDirectory(config, value) {
  if (value === undefined) {
    return config;
  }
  if (value !== "../../release-candidate/migrations") {
    throw new Error("Candidate migrations directory is invalid");
  }
  const source = 'migrations_dir = "../../migrations"';
  if (!config.includes(source)) {
    throw new Error("Orchestrator migrations directory was not found");
  }
  return config.replaceAll(source, `migrations_dir = "${value}"`);
}

function validatedResourceIdentifiers(identifiers) {
  return {
    accountId: requireIdentifier(identifiers.accountId, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID"),
    d1DatabaseId: requireIdentifier(
      identifiers.d1DatabaseId,
      d1DatabaseIdPattern,
      "SCRIBE_DROP_STAGING_D1_DATABASE_ID",
    ),
  };
}

function optionalPositiveInteger(value, fallback, name, maximum) {
  const candidate = value === undefined ? String(fallback) : value;
  if (
    typeof candidate !== "string" ||
    !/^[1-9][0-9]*$/u.test(candidate) ||
    Number(candidate) > maximum
  ) {
    throw new Error(`${name} is missing or has an invalid format`);
  }
  return Number(candidate);
}

function validatedRetentionIdentifiers(identifiers) {
  const values = {
    auditRetentionDays: optionalPositiveInteger(
      identifiers.auditRetentionDays,
      retentionDefaults.auditRetentionDays,
      "AUDIT_RETENTION_DAYS",
      3650,
    ),
    multipartRetentionHours: optionalPositiveInteger(
      identifiers.multipartRetentionHours,
      retentionDefaults.multipartRetentionHours,
      "MULTIPART_RETENTION_HOURS",
      24 * 30,
    ),
    resultRetentionDays: optionalPositiveInteger(
      identifiers.resultRetentionDays,
      retentionDefaults.resultRetentionDays,
      "RESULT_RETENTION_DAYS",
      3650,
    ),
    sourceRetentionDays: optionalPositiveInteger(
      identifiers.sourceRetentionDays,
      retentionDefaults.sourceRetentionDays,
      "SOURCE_RETENTION_DAYS",
      3650,
    ),
  };
  if (
    values.sourceRetentionDays > values.resultRetentionDays ||
    values.resultRetentionDays > values.auditRetentionDays
  ) {
    throw new Error("Retention must satisfy source <= result <= audit");
  }
  return values;
}

function validatedRunpodPlacementPolicy(identifiers, environment) {
  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}_RUNPOD`;
  const image = requireIdentifier(
    identifiers.runpodWorkerImage,
    runpodImagePattern,
    `${prefix}_IMAGE`,
  );
  if (typeof identifiers.runpodAllowedGpuTypeIds !== "string") {
    throw new Error(`${prefix}_GPU_IDS is missing or has an invalid format`);
  }
  const gpuTypeIds = identifiers.runpodAllowedGpuTypeIds
    .split(",")
    .map((candidate) => candidate.trim());
  if (
    gpuTypeIds.length === 0 ||
    gpuTypeIds.length > 3 ||
    gpuTypeIds.some((candidate) => !runpodGpuIdPattern.test(candidate)) ||
    new Set(gpuTypeIds).size !== gpuTypeIds.length
  ) {
    throw new Error(`${prefix}_GPU_IDS is missing or has an invalid format`);
  }
  return {
    gpuTypeIds: gpuTypeIds.join(","),
    image,
  };
}

export function renderOrchestratorStagingConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedResourceIdentifiers(identifiers);
  const retention = validatedRetentionIdentifiers(identifiers);
  const runpodPlacement = validatedRunpodPlacementPolicy(identifiers, "staging");
  const orchestratorOrigin = requireExactHttpsOrigin(
    identifiers.orchestratorOrigin,
    "SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN",
  );
  const orchestratorHostname = new URL(orchestratorOrigin).hostname;
  const cloudRun = validatedStagingCloudRunConfiguration(identifiers, orchestratorOrigin);
  const gpuExecutionPolicy = validatedStagingGpuExecutionPolicy(identifiers, cloudRun);
  const gpuExecutionAdmission = validatedGpuExecutionAdmission(identifiers, "staging");
  const acceptanceFault = validateStagingAcceptanceFaultIdentifiers(identifiers, cloudRun.mode);
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_STAGING_WEB_ORIGIN",
  );
  const stagingMarker = "[env.staging]";
  const stagingIndex = template.indexOf(stagingMarker);
  if (stagingIndex === -1) {
    throw new Error("orchestrator staging environment was not found");
  }
  const productionIndex = template.indexOf("[env.production]", stagingIndex);

  const baseConfig = template.slice(0, stagingIndex);
  let stagingConfig =
    productionIndex === -1
      ? template.slice(stagingIndex)
      : template.slice(stagingIndex, productionIndex);
  stagingConfig = replaceOnce(
    stagingConfig,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "orchestrator staging account ID",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `database_id = "${stagingD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "orchestrator staging D1 database ID",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `pattern = "${stagingOrchestratorHostnamePlaceholder}"`,
    `pattern = "${orchestratorHostname}"`,
    "orchestrator staging custom domain",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `RUNPOD_INTERNAL_BASE_URL = "${stagingOrchestratorOriginPlaceholder}"`,
    `RUNPOD_INTERNAL_BASE_URL = "${orchestratorOrigin}"`,
    "orchestrator staging internal origin",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    'GPU_EXECUTION_POLICY = "runpod_serverless_v1"',
    `GPU_EXECUTION_POLICY = "${gpuExecutionPolicy}"`,
    "orchestrator staging GPU execution policy",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    'GPU_EXECUTION_ADMISSION = "active"',
    `GPU_EXECUTION_ADMISSION = "${gpuExecutionAdmission}"`,
    "orchestrator staging GPU execution admission",
  );
  const cloudRunBindings = [
    [
      `CLOUD_RUN_CONTROLLER_ORIGIN = "${stagingCloudRunControllerOriginPlaceholder}"`,
      `CLOUD_RUN_CONTROLLER_ORIGIN = "${cloudRun.controllerOrigin}"`,
      "orchestrator staging Cloud Run controller origin",
    ],
    [
      `CLOUD_RUN_ORCHESTRATOR_ORIGIN = "${stagingCloudRunOrchestratorOriginPlaceholder}"`,
      `CLOUD_RUN_ORCHESTRATOR_ORIGIN = "${cloudRun.orchestratorOrigin}"`,
      "orchestrator staging Cloud Run orchestrator origin",
    ],
    [
      'CLOUD_RUN_RUNTIME_MODE = "disabled"',
      `CLOUD_RUN_RUNTIME_MODE = "${cloudRun.mode}"`,
      "orchestrator staging Cloud Run runtime mode",
    ],
    [
      `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT = "${stagingCloudRunRuntimeServiceAccountPlaceholder}"`,
      `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT = "${cloudRun.runtimeServiceAccount}"`,
      "orchestrator staging Cloud Run runtime service account",
    ],
  ];
  for (const [source, activeValue, label] of cloudRunBindings) {
    stagingConfig = replaceOnce(
      stagingConfig,
      `${source}\n`,
      cloudRun.mode === "disabled" ? "" : `${activeValue}\n`,
      label,
    );
  }
  if (acceptanceFault !== undefined) {
    stagingConfig = replaceOnce(
      stagingConfig,
      "[env.staging.vars]\n",
      [
        "[env.staging.vars]",
        `STAGING_ACCEPTANCE_FAULT = "${acceptanceFault.fault}"`,
        `STAGING_ACCEPTANCE_FAULT_EXPIRES_AT = "${acceptanceFault.expiresAt}"`,
        `STAGING_ACCEPTANCE_FAULT_ISSUED_AT = "${acceptanceFault.issuedAt}"`,
        `STAGING_ACCEPTANCE_FAULT_JOB_ID = "${acceptanceFault.jobId}"`,
        "",
      ].join("\n"),
      "orchestrator staging acceptance fault variables",
    );
  }
  stagingConfig = replaceOnce(
    stagingConfig,
    `RUNPOD_ALLOWED_GPU_IDS = "${runpodGpuIdsPlaceholder}"`,
    `RUNPOD_ALLOWED_GPU_IDS = "${runpodPlacement.gpuTypeIds}"`,
    "orchestrator staging RunPod GPU policy",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `RUNPOD_WORKER_IMAGE = "${runpodWorkerImagePlaceholder}"`,
    `RUNPOD_WORKER_IMAGE = "${runpodPlacement.image}"`,
    "orchestrator staging RunPod worker image",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `WEB_BASE_URL = "${webOriginPlaceholder}"`,
    `WEB_BASE_URL = "${webOrigin}"`,
    "orchestrator staging web origin",
  );
  for (const [name, defaultValue, renderedValue] of [
    ["AUDIT_RETENTION_DAYS", retentionDefaults.auditRetentionDays, retention.auditRetentionDays],
    [
      "MULTIPART_RETENTION_HOURS",
      retentionDefaults.multipartRetentionHours,
      retention.multipartRetentionHours,
    ],
    ["RESULT_RETENTION_DAYS", retentionDefaults.resultRetentionDays, retention.resultRetentionDays],
    ["SOURCE_RETENTION_DAYS", retentionDefaults.sourceRetentionDays, retention.sourceRetentionDays],
  ]) {
    stagingConfig = replaceOnce(
      stagingConfig,
      `${name} = "${String(defaultValue)}"`,
      `${name} = "${String(renderedValue)}"`,
      `orchestrator staging ${name}`,
    );
  }

  return renderMigrationsDirectory(
    replaceOnce(
      `${baseConfig}${stagingConfig}`,
      'main = "src/index.ts"',
      'main = "../../apps/orchestrator/src/index.ts"',
      "orchestrator entrypoint",
    ),
    identifiers.candidateMigrationsDirectory,
  );
}

export function renderWebStagingConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedResourceIdentifiers(identifiers);
  const accessAudience = requireIdentifier(
    identifiers.accessAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_STAGING_ACCESS_AUDIENCE",
  );
  const pagesAccessAudience = requireIdentifier(
    identifiers.pagesAccessAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE",
  );
  if (accessAudience === pagesAccessAudience) {
    throw new Error("Staging custom-domain and Pages Access audiences must be distinct");
  }
  const accessTeamDomain = requireIdentifier(
    identifiers.accessTeamDomain,
    accessTeamDomainPattern,
    "SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN",
  );
  const stagingE2eServiceTokenCommonName = requireIdentifier(
    identifiers.stagingE2eServiceTokenCommonName,
    serviceTokenCommonNamePattern,
    "SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  );
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_STAGING_WEB_ORIGIN",
  );
  let rendered = replaceOnce(
    template,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "web staging account ID",
  );
  rendered = replaceOnce(
    rendered,
    `database_id = "${stagingD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "web staging D1 database ID",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomainPlaceholder}"`,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomain}"`,
    "web staging Access team domain",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudiencePlaceholder]))}`,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudience, pagesAccessAudience]))}`,
    "web staging Access audiences",
  );
  rendered = replaceOnce(
    rendered,
    `ALLOWED_ORIGIN = "${webOriginPlaceholder}"`,
    `ALLOWED_ORIGIN = "${webOrigin}"`,
    "web staging origin",
  );
  rendered = replaceOnce(
    rendered,
    `STAGING_E2E_SERVICE_TOKEN_COMMON_NAME = "${stagingE2eServiceTokenCommonNamePlaceholder}"`,
    `STAGING_E2E_SERVICE_TOKEN_COMMON_NAME = "${stagingE2eServiceTokenCommonName}"`,
    "web staging E2E service token common name",
  );

  const queueProducer = `[[queues.producers]]
binding = "CONTROL_EVENTS"
queue = "recording-uploaded-staging"`;
  rendered = replaceOnce(
    rendered,
    queueProducer,
    queueProducer,
    "web staging control Queue producer",
  );

  return replaceOnce(
    rendered,
    'pages_build_output_dir = "./dist"',
    'pages_build_output_dir = "../../dist"',
    "web build output directory",
  );
}

export function renderR2CorsStagingConfig(template, identifiers) {
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_STAGING_WEB_ORIGIN",
  );
  return replaceOnce(
    template,
    `"origins": ["${webOriginPlaceholder}"]`,
    `"origins": ["${webOrigin}"]`,
    "R2 CORS staging origin",
  );
}

export function renderR2LifecycleStagingConfig(template, identifiers) {
  const retention = validatedRetentionIdentifiers(identifiers);
  let parsed;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new Error("R2 lifecycle template is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(parsed.rules) ||
    parsed.rules.length !== 2
  ) {
    throw new Error("R2 lifecycle template has an unexpected shape");
  }
  const incoming = parsed.rules.find(
    (rule) => rule?.id === "scribe-drop-incoming-retention-staging",
  );
  const results = parsed.rules.find((rule) => rule?.id === "scribe-drop-results-retention-staging");
  if (
    incoming?.conditions?.prefix !== "incoming/" ||
    incoming?.deleteObjectsTransition?.condition?.maxAge !==
      retentionDefaults.sourceRetentionDays * 86400 ||
    incoming?.abortMultipartUploadsTransition?.condition?.maxAge !==
      retentionDefaults.multipartRetentionHours * 3600 ||
    results?.conditions?.prefix !== "results/" ||
    results?.deleteObjectsTransition?.condition?.maxAge !==
      retentionDefaults.resultRetentionDays * 86400
  ) {
    throw new Error("R2 lifecycle template has drifted from the reviewed defaults");
  }
  incoming.deleteObjectsTransition.condition.maxAge = retention.sourceRetentionDays * 86400;
  incoming.abortMultipartUploadsTransition.condition.maxAge =
    retention.multipartRetentionHours * 3600;
  results.deleteObjectsTransition.condition.maxAge = retention.resultRetentionDays * 86400;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function validatedProductionResourceIdentifiers(identifiers) {
  return {
    accountId: requireIdentifier(identifiers.accountId, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID"),
    d1DatabaseId: requireIdentifier(
      identifiers.d1DatabaseId,
      d1DatabaseIdPattern,
      "SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID",
    ),
  };
}

export function renderOrchestratorProductionConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedProductionResourceIdentifiers(identifiers);
  const retention = validatedRetentionIdentifiers(identifiers);
  const runpodPlacement = validatedRunpodPlacementPolicy(identifiers, "production");
  if (stagingAcceptanceFaultIdentifierKeys.some((key) => identifiers[key] !== undefined)) {
    throw new Error("Staging acceptance fault configuration is forbidden in production");
  }
  const orchestratorOrigin = requireExactHttpsOrigin(
    identifiers.orchestratorOrigin,
    "SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN",
  );
  rejectEnvironmentMarker(
    orchestratorOrigin,
    "staging",
    "SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN",
  );
  const orchestratorHostname = new URL(orchestratorOrigin).hostname;
  const cloudRun = validatedProductionCloudRunConfiguration(identifiers, orchestratorOrigin);
  const gpuExecutionPolicy = validatedProductionGpuExecutionPolicy(identifiers, cloudRun);
  const gpuExecutionAdmission = validatedGpuExecutionAdmission(identifiers, "production");
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN",
  );
  rejectEnvironmentMarker(webOrigin, "staging", "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN");
  const productionMarker = "[env.production]";
  const productionIndex = template.indexOf(productionMarker);
  if (productionIndex === -1) {
    throw new Error("orchestrator production environment was not found");
  }

  const precedingConfig = template.slice(0, productionIndex);
  const stagingIndex = precedingConfig.indexOf("[env.staging");
  const baseConfig = stagingIndex === -1 ? precedingConfig : precedingConfig.slice(0, stagingIndex);
  let productionConfig = template.slice(productionIndex);
  if (/^[\t ]*STAGING_ACCEPTANCE_FAULT(?:_[A-Z_]+)?[\t ]*=/mu.test(productionConfig)) {
    throw new Error("Staging acceptance fault variables are forbidden in production");
  }
  productionConfig = replaceOnce(
    productionConfig,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "orchestrator production account ID",
  );
  productionConfig = replaceOnce(
    productionConfig,
    `database_id = "${productionD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "orchestrator production D1 database ID",
  );
  productionConfig = replaceOnce(
    productionConfig,
    `pattern = "${productionOrchestratorHostnamePlaceholder}"`,
    `pattern = "${orchestratorHostname}"`,
    "orchestrator production custom domain",
  );
  productionConfig = replaceOnce(
    productionConfig,
    `RUNPOD_INTERNAL_BASE_URL = "${productionOrchestratorOriginPlaceholder}"`,
    `RUNPOD_INTERNAL_BASE_URL = "${orchestratorOrigin}"`,
    "orchestrator production internal origin",
  );
  productionConfig = replaceOnce(
    productionConfig,
    'GPU_EXECUTION_POLICY = "runpod_serverless_v1"',
    `GPU_EXECUTION_POLICY = "${gpuExecutionPolicy}"`,
    "orchestrator production GPU execution policy",
  );
  productionConfig = replaceOnce(
    productionConfig,
    'GPU_EXECUTION_ADMISSION = "active"',
    `GPU_EXECUTION_ADMISSION = "${gpuExecutionAdmission}"`,
    "orchestrator production GPU execution admission",
  );
  const cloudRunBindings = [
    [
      `CLOUD_RUN_CONTROLLER_ORIGIN = "${productionCloudRunControllerOriginPlaceholder}"`,
      `CLOUD_RUN_CONTROLLER_ORIGIN = "${cloudRun.controllerOrigin}"`,
      "orchestrator production Cloud Run controller origin",
    ],
    [
      `CLOUD_RUN_ORCHESTRATOR_ORIGIN = "${productionCloudRunOrchestratorOriginPlaceholder}"`,
      `CLOUD_RUN_ORCHESTRATOR_ORIGIN = "${cloudRun.orchestratorOrigin}"`,
      "orchestrator production Cloud Run orchestrator origin",
    ],
    [
      'CLOUD_RUN_RUNTIME_MODE = "disabled"',
      `CLOUD_RUN_RUNTIME_MODE = "${cloudRun.mode}"`,
      "orchestrator production Cloud Run runtime mode",
    ],
    [
      `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT = "${productionCloudRunRuntimeServiceAccountPlaceholder}"`,
      `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT = "${cloudRun.runtimeServiceAccount}"`,
      "orchestrator production Cloud Run runtime service account",
    ],
  ];
  for (const [source, activeValue, label] of cloudRunBindings) {
    productionConfig = replaceOnce(
      productionConfig,
      `${source}\n`,
      cloudRun.mode === "disabled" ? "" : `${activeValue}\n`,
      label,
    );
  }
  productionConfig = replaceOnce(
    productionConfig,
    `RUNPOD_ALLOWED_GPU_IDS = "${runpodGpuIdsPlaceholder}"`,
    `RUNPOD_ALLOWED_GPU_IDS = "${runpodPlacement.gpuTypeIds}"`,
    "orchestrator production RunPod GPU policy",
  );
  productionConfig = replaceOnce(
    productionConfig,
    `RUNPOD_WORKER_IMAGE = "${runpodWorkerImagePlaceholder}"`,
    `RUNPOD_WORKER_IMAGE = "${runpodPlacement.image}"`,
    "orchestrator production RunPod worker image",
  );
  productionConfig = replaceOnce(
    productionConfig,
    `WEB_BASE_URL = "${productionWebOriginPlaceholder}"`,
    `WEB_BASE_URL = "${webOrigin}"`,
    "orchestrator production web origin",
  );
  for (const [name, defaultValue, renderedValue] of [
    ["AUDIT_RETENTION_DAYS", retentionDefaults.auditRetentionDays, retention.auditRetentionDays],
    [
      "MULTIPART_RETENTION_HOURS",
      retentionDefaults.multipartRetentionHours,
      retention.multipartRetentionHours,
    ],
    ["RESULT_RETENTION_DAYS", retentionDefaults.resultRetentionDays, retention.resultRetentionDays],
    ["SOURCE_RETENTION_DAYS", retentionDefaults.sourceRetentionDays, retention.sourceRetentionDays],
  ]) {
    productionConfig = replaceOnce(
      productionConfig,
      `${name} = "${String(defaultValue)}"`,
      `${name} = "${String(renderedValue)}"`,
      `orchestrator production ${name}`,
    );
  }

  return renderMigrationsDirectory(
    replaceOnce(
      `${baseConfig}${productionConfig}`,
      'main = "src/index.ts"',
      'main = "../../apps/orchestrator/src/index.ts"',
      "orchestrator entrypoint",
    ),
    identifiers.candidateMigrationsDirectory,
  );
}

export function renderWebProductionConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedProductionResourceIdentifiers(identifiers);
  const accessAudience = requireIdentifier(
    identifiers.accessAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE",
  );
  rejectEnvironmentMarker(accessAudience, "staging", "SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE");
  const accessTeamDomain = requireIdentifier(
    identifiers.accessTeamDomain,
    accessTeamDomainPattern,
    "SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN",
  );
  rejectEnvironmentMarker(accessTeamDomain, "staging", "SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN");
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN",
  );
  rejectEnvironmentMarker(webOrigin, "staging", "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN");
  let rendered = replaceOnce(
    template,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "web production account ID",
  );
  rendered = replaceOnce(
    rendered,
    `database_id = "${productionD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "web production D1 database ID",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomainPlaceholder}"`,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomain}"`,
    "web production Access team domain",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudiencePlaceholder]))}`,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudience]))}`,
    "web production Access audience",
  );
  rendered = replaceOnce(
    rendered,
    `ALLOWED_ORIGIN = "${productionWebOriginPlaceholder}"`,
    `ALLOWED_ORIGIN = "${webOrigin}"`,
    "web production origin",
  );

  const queueProducer = `[[queues.producers]]
binding = "CONTROL_EVENTS"
queue = "recording-uploaded-production"`;
  rendered = replaceOnce(
    rendered,
    queueProducer,
    queueProducer,
    "web production control Queue producer",
  );

  return replaceOnce(
    rendered,
    'pages_build_output_dir = "./dist"',
    'pages_build_output_dir = "../../dist"',
    "web build output directory",
  );
}

export function renderR2CorsProductionConfig(template, identifiers) {
  const webOrigin = requireExactHttpsOrigin(
    identifiers.webOrigin,
    "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN",
  );
  rejectEnvironmentMarker(webOrigin, "staging", "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN");
  return replaceOnce(
    template,
    `"origins": ["${productionWebOriginPlaceholder}"]`,
    `"origins": ["${webOrigin}"]`,
    "R2 CORS production origin",
  );
}

export function renderR2LifecycleProductionConfig(template, identifiers) {
  const retention = validatedRetentionIdentifiers(identifiers);
  let parsed;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new Error("R2 lifecycle template is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(parsed.rules) ||
    parsed.rules.length !== 2
  ) {
    throw new Error("R2 lifecycle template has an unexpected shape");
  }
  const incoming = parsed.rules.find(
    (rule) => rule?.id === "scribe-drop-incoming-retention-production",
  );
  const results = parsed.rules.find(
    (rule) => rule?.id === "scribe-drop-results-retention-production",
  );
  if (
    incoming?.conditions?.prefix !== "incoming/" ||
    incoming?.deleteObjectsTransition?.condition?.maxAge !==
      retentionDefaults.sourceRetentionDays * 86400 ||
    incoming?.abortMultipartUploadsTransition?.condition?.maxAge !==
      retentionDefaults.multipartRetentionHours * 3600 ||
    results?.conditions?.prefix !== "results/" ||
    results?.deleteObjectsTransition?.condition?.maxAge !==
      retentionDefaults.resultRetentionDays * 86400
  ) {
    throw new Error("R2 lifecycle template has drifted from the reviewed defaults");
  }
  incoming.deleteObjectsTransition.condition.maxAge = retention.sourceRetentionDays * 86400;
  incoming.abortMultipartUploadsTransition.condition.maxAge =
    retention.multipartRetentionHours * 3600;
  results.deleteObjectsTransition.condition.maxAge = retention.resultRetentionDays * 86400;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
