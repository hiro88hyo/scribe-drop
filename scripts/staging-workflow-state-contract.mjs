import { parsers } from "prettier/plugins/yaml";

const MODE = "SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_MODE";
const POLICY = "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY";
const ADMISSION = "SCRIBE_DROP_STAGING_GPU_EXECUTION_ADMISSION";

function unwrap(node) {
  let current = node;
  while (
    current !== undefined &&
    new Set(["mappingKey", "mappingValue", "sequenceItem", "documentBody"]).has(current.type)
  ) {
    current = current.children?.[0];
  }
  return current;
}

function keyOf(item) {
  const key = unwrap(item?.children?.[0]);
  return typeof key?.value === "string" ? key.value : undefined;
}

function mappingValue(mapping, key) {
  const normalized = unwrap(mapping);
  if (normalized?.type !== "mapping") throw new Error(`${key} parent is not a mapping`);
  const item = normalized.children?.find((candidate) => keyOf(candidate) === key);
  if (item === undefined) throw new Error(`Workflow mapping is missing ${key}`);
  return unwrap(item.children?.[1]);
}

function optionalMappingValue(mapping, key) {
  const normalized = unwrap(mapping);
  if (normalized?.type !== "mapping") return undefined;
  const item = normalized.children?.find((candidate) => keyOf(candidate) === key);
  return item === undefined ? undefined : unwrap(item.children?.[1]);
}

function mappingObject(mapping) {
  const normalized = unwrap(mapping);
  if (normalized?.type !== "mapping") return {};
  return Object.fromEntries(
    (normalized.children ?? []).flatMap((item) => {
      const key = keyOf(item);
      const value = unwrap(item.children?.[1]);
      return key === undefined || value?.value === undefined ? [] : [[key, String(value.value)]];
    }),
  );
}

function rootMapping(root) {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node?.type === "mapping") return node;
    if (Array.isArray(node?.children)) queue.push(...node.children);
  }
  throw new Error("Workflow document mapping is missing");
}

function job(workflow, name) {
  return mappingValue(mappingValue(rootMapping(workflow), "jobs"), name);
}

function jobEntries(workflow) {
  const jobs = unwrap(mappingValue(rootMapping(workflow), "jobs"));
  if (jobs?.type !== "mapping") throw new Error("Workflow jobs are not a mapping");
  return (jobs.children ?? []).map((item) => {
    const name = keyOf(item);
    const mapping = unwrap(item.children?.[1]);
    if (name === undefined || mapping?.type !== "mapping") {
      throw new Error("Workflow job entry is invalid");
    }
    return [name, mapping];
  });
}

function jobEnvironment(jobMapping) {
  return mappingObject(mappingValue(jobMapping, "env"));
}

function step(jobMapping, name) {
  const steps = mappingValue(jobMapping, "steps");
  if (steps?.type !== "sequence") throw new Error("Workflow steps are not a sequence");
  const found = steps.children?.map(unwrap).find((item) => {
    const stepName = optionalMappingValue(item, "name");
    return stepName?.value === name;
  });
  if (found === undefined) throw new Error(`Workflow step is missing ${name}`);
  return found;
}

function namedSteps(jobMapping) {
  const steps = mappingValue(jobMapping, "steps");
  if (steps?.type !== "sequence") throw new Error("Workflow steps are not a sequence");
  return (steps.children ?? []).map(unwrap).map((item) => ({
    mapping: item,
    name: String(optionalMappingValue(item, "name")?.value ?? "unnamed step"),
  }));
}

function profile(environment) {
  return {
    admission: environment[ADMISSION],
    mode: environment[MODE],
    policy: environment[POLICY],
  };
}

function stepProfile(jobMapping, name) {
  const selectedStep = step(jobMapping, name);
  return profile({
    ...jobEnvironment(jobMapping),
    ...mappingObject(optionalMappingValue(selectedStep, "env")),
  });
}

function requireProfile(actual, expected, location) {
  for (const key of ["mode", "policy", "admission"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${location} ${key} must be ${expected[key]}, received ${actual[key] ?? "missing"}`,
      );
    }
  }
}

const finalPolicy = Object.freeze({
  admission: "active",
  mode: "synthetic-shadow",
  policy: "cloud_run_jobs_l4_v1",
});
const runpodBaseline = Object.freeze({
  admission: "active",
  mode: "synthetic-shadow",
  policy: "runpod_serverless_v1",
});

const workflowRunInputs = Object.freeze({
  ".github/workflows/publish-cloud-run-candidate.yml": Object.freeze({
    expression: "${{ inputs.cloud_run_candidate_run_id }}",
    variable: "CLOUD_RUN_CANDIDATE_RUN_ID",
  }),
  ".github/workflows/publish-runpod-worker.yml": Object.freeze({
    expression: "${{ inputs.candidate_run_id }}",
    variable: "CANDIDATE_RUN_ID",
  }),
});

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function requireWorkflowRunIdentity(jobName, jobMapping) {
  const identitySteps = namedSteps(jobMapping).filter(({ mapping }) =>
    String(optionalMappingValue(mapping, "run")?.value ?? "").includes(
      "scripts/verify-workflow-run.mjs",
    ),
  );
  if (identitySteps.length === 0) return 0;

  const environment = jobEnvironment(jobMapping);
  for (const [name, expected] of [
    ["EXPECTED_COMMIT_SHA", "${{ inputs.candidate_commit_sha || github.sha }}"],
    ["EXPECTED_RELEASE_BRANCH", "${{ github.ref_name }}"],
  ]) {
    if (environment[name] !== expected) {
      throw new Error(
        `${jobName} job ${name} must be ${expected}, received ${environment[name] ?? "missing"}`,
      );
    }
  }

  let verifiedCalls = 0;
  for (const identityStep of identitySteps) {
    const run = String(optionalMappingValue(identityStep.mapping, "run")?.value ?? "");
    const callCount = countOccurrences(run, "node scripts/verify-workflow-run.mjs");
    const matches = [
      ...run.matchAll(
        /node scripts\/verify-workflow-run\.mjs\s+\\\s+[^\n]+\s+\\\s+(\.github\/workflows\/[^\s]+)\s+\\\s+"\$\{([A-Z][A-Z0-9_]*)\}"/gu,
      ),
    ];
    if (matches.length !== callCount) {
      throw new Error(
        `${jobName} job ${identityStep.name} must bind every workflow verifier to an input run ID`,
      );
    }

    const stepEnvironment = {
      ...environment,
      ...mappingObject(optionalMappingValue(identityStep.mapping, "env")),
    };
    for (const match of matches) {
      const workflowPath = match[1];
      const runIdVariable = match[2];
      const expectedInput = workflowRunInputs[workflowPath];
      if (expectedInput === undefined) {
        throw new Error(
          `${jobName} job ${identityStep.name} verifies an unsupported workflow ${workflowPath}`,
        );
      }
      if (runIdVariable !== expectedInput.variable) {
        throw new Error(
          `${jobName} job ${identityStep.name} must verify ${workflowPath} with ${expectedInput.variable}`,
        );
      }
      if (stepEnvironment[runIdVariable] !== expectedInput.expression) {
        throw new Error(
          `${jobName} job ${identityStep.name} ${runIdVariable} must be ${expectedInput.expression}, received ${stepEnvironment[runIdVariable] ?? "missing"}`,
        );
      }
      verifiedCalls += 1;
    }
  }
  return verifiedCalls;
}

export async function verifyStagingWorkflowStateContract(source) {
  const workflow = await parsers.yaml.parse(source, { filepath: "deploy-staging-candidate.yml" });
  const allJobs = jobEntries(workflow);
  const jobs = Object.fromEntries(
    ["preflight", "migrate", "deploy-backend", "acceptance", "recover-acceptance"].map((name) => [
      name,
      job(workflow, name),
    ]),
  );

  requireProfile(profile(jobEnvironment(jobs.preflight)), finalPolicy, "preflight job");
  requireProfile(
    stepProfile(jobs.preflight, "Export normalized staging environment policy"),
    finalPolicy,
    "preflight parity export",
  );
  requireProfile(profile(jobEnvironment(jobs.migrate)), runpodBaseline, "migration job");
  requireProfile(profile(jobEnvironment(jobs["deploy-backend"])), runpodBaseline, "backend job");
  requireProfile(
    stepProfile(jobs["deploy-backend"], "Deploy exact candidate Orchestrator bundle"),
    runpodBaseline,
    "backend deployment",
  );
  requireProfile(profile(jobEnvironment(jobs.acceptance)), finalPolicy, "acceptance job");
  requireProfile(
    stepProfile(jobs.acceptance, "Pause staging admission before bounded authorization"),
    { ...finalPolicy, admission: "paused" },
    "acceptance pause",
  );
  requireProfile(
    stepProfile(
      jobs.acceptance,
      "Activate staging admission and render exact acceptance configuration",
    ),
    finalPolicy,
    "acceptance activation",
  );
  requireProfile(
    stepProfile(jobs.acceptance, "Restore RunPod selection while preserving the Cloud Run reaper"),
    runpodBaseline,
    "acceptance restore",
  );
  requireProfile(
    stepProfile(
      jobs["recover-acceptance"],
      "Pause all new GPU admission on the RunPod recovery policy",
    ),
    { ...runpodBaseline, admission: "paused" },
    "recovery pause",
  );
  requireProfile(
    stepProfile(
      jobs["recover-acceptance"],
      "Reactivate RunPod only after Cloud Run is disabled and empty",
    ),
    runpodBaseline,
    "recovery reactivation",
  );
  requireProfile(
    stepProfile(
      jobs["recover-acceptance"],
      "Verify recovered staging safety without issuing acceptance",
    ),
    runpodBaseline,
    "recovery verification",
  );

  const workflowIdentity = Object.fromEntries(
    allJobs.flatMap(([name, jobMapping]) => {
      const verifiedCalls = requireWorkflowRunIdentity(name, jobMapping);
      return verifiedCalls === 0 ? [] : [[name, verifiedCalls]];
    }),
  );

  return {
    acceptedParity: finalPolicy,
    paidExecutions: 1,
    preAcceptanceDeployment: runpodBaseline,
    recovery: runpodBaseline,
    workflowIdentity,
  };
}
