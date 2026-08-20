import { parsers } from "prettier/plugins/yaml";

export const controllerBuildScript = "pnpm run workflow:build:gpu-controller";
const controllerBuildImplementation = "pnpm --filter '@scribe-drop/gpu-controller...' run build";

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

function rootMapping(root) {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node?.type === "mapping") return node;
    if (Array.isArray(node?.children)) queue.push(...node.children);
  }
  throw new Error("Workflow document mapping is missing");
}

function namedMappings(mapping, location) {
  const normalized = unwrap(mapping);
  if (normalized?.type !== "mapping") throw new Error(`${location} is not a mapping`);
  return (normalized.children ?? []).map((item) => {
    const name = keyOf(item);
    const value = unwrap(item.children?.[1]);
    if (name === undefined || value?.type !== "mapping") {
      throw new Error(`${location} entry is invalid`);
    }
    return [name, value];
  });
}

function namedSteps(job, jobName) {
  const steps = mappingValue(job, "steps");
  if (steps?.type !== "sequence") throw new Error(`${jobName} steps are not a sequence`);
  return (steps.children ?? []).map(unwrap).map((step) => ({
    name: String(optionalMappingValue(step, "name")?.value ?? "unnamed step"),
    run: String(optionalMappingValue(step, "run")?.value ?? ""),
  }));
}

export function verifyControllerBuildPackageContract(source) {
  const manifest = JSON.parse(source);
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json scripts are missing");
  }
  if (scripts["workflow:build:gpu-controller"] !== controllerBuildImplementation) {
    throw new Error(
      `workflow:build:gpu-controller must build the complete dependency closure with ${controllerBuildImplementation}`,
    );
  }

  const check = scripts["check"];
  if (typeof check !== "string") throw new Error("package.json check script is missing");
  const initialSteps = check.split(" && ").slice(0, 4);
  const expectedInitialSteps = [
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm workflow:build:gpu-controller",
  ];
  if (JSON.stringify(initialSteps) !== JSON.stringify(expectedInitialSteps)) {
    throw new Error(
      "check must exercise the controller dependency closure before tests or aggregate builds",
    );
  }
  return controllerBuildImplementation;
}

export async function verifyWorkflowControllerBuildContract(
  source,
  { expectedBuilds, workflowName },
) {
  const workflow = await parsers.yaml.parse(source, { filepath: workflowName });
  const jobs = namedMappings(mappingValue(rootMapping(workflow), "jobs"), "workflow jobs");
  const buildSteps = [];

  for (const [jobName, job] of jobs) {
    for (const step of namedSteps(job, jobName)) {
      const relevantLines = step.run
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("gpu-controller") && line.includes("build"));
      for (const line of relevantLines) {
        if (line !== controllerBuildScript) {
          throw new Error(
            `${workflowName} ${jobName} / ${step.name} must use ${controllerBuildScript}, received ${line}`,
          );
        }
        buildSteps.push(`${jobName} / ${step.name}`);
      }
    }
  }

  if (buildSteps.length !== expectedBuilds) {
    throw new Error(
      `${workflowName} must contain ${expectedBuilds} dependency-closed controller builds, received ${buildSteps.length}`,
    );
  }
  return buildSteps;
}
