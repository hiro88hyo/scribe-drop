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

export async function verifyStagingWorkflowStateContract(source) {
  const workflow = await parsers.yaml.parse(source, { filepath: "deploy-staging-candidate.yml" });
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

  return {
    acceptedParity: finalPolicy,
    paidExecutions: 1,
    preAcceptanceDeployment: runpodBaseline,
    recovery: runpodBaseline,
  };
}
