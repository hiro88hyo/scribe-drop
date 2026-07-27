import {
  createRunpodTemplateArguments,
  validateCreatedRunpodEndpoint,
  validateCreatedRunpodTemplate,
  validateRunpodPlan,
} from "./runpod-environment-config.mjs";

const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireResourceId(value, name) {
  if (typeof value !== "string" || !resourceIdPattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function validateNoActiveWorkers(untrustedWorkers) {
  const terminalStatuses = new Set(["EXITED", "TERMINATED"]);
  const workers = requireArray(untrustedWorkers, "RunPod endpoint workers");
  if (
    workers.some((untrustedWorker) => {
      const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
      return !terminalStatuses.has(worker.desiredStatus);
    })
  ) {
    throw new Error("RunPod endpoint has active or unrecognized workers and cannot be promoted");
  }
}

function validateIdleEndpoint(untrustedEndpoint, plan, effectiveTemplateId) {
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  const currentTemplateId = requireResourceId(endpoint.templateId, "RunPod current template ID");
  validateNoActiveWorkers(endpoint.workers);
  validateCreatedRunpodEndpoint(
    { ...endpoint, templateId: effectiveTemplateId },
    plan,
    effectiveTemplateId,
  );
  return currentTemplateId;
}

function matchingTemplates(templates, name) {
  return templates.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.name === name,
  );
}

function getOrCreateTemplate(plan, runCli) {
  const matches = matchingTemplates(
    requireArray(runCli(["template", "list", "--type", "user"]), "RunPod template list"),
    plan.template.name,
  );
  if (matches.length > 1) {
    throw new Error("Multiple RunPod templates match the candidate plan");
  }
  if (matches.length === 1) {
    const summary = requireRecord(matches[0], "RunPod template summary");
    const templateId = requireResourceId(summary.id, "RunPod template ID");
    return validateCreatedRunpodTemplate(runCli(["template", "get", templateId]), plan);
  }

  return validateCreatedRunpodTemplate(runCli(createRunpodTemplateArguments(plan)), plan);
}

export function promoteRunpodCandidate(input) {
  const plan = validateRunpodPlan(input.plan, input.environment);
  const endpointId = requireResourceId(input.endpointId, "RunPod endpoint ID");
  input.runCli(["user"]);
  const templateId = getOrCreateTemplate(plan, input.runCli);
  const getEndpoint = () =>
    input.runCli(["serverless", "get", endpointId, "--include-template", "--include-workers"]);
  const before = getEndpoint();
  const previousTemplateId = validateIdleEndpoint(before, plan, templateId);
  if (previousTemplateId === templateId) {
    validateCreatedRunpodEndpoint(before, plan, templateId);
    return { changed: false, endpointId, templateId };
  }

  input.runCli(["serverless", "update", endpointId, "--template-id", templateId]);
  try {
    const after = getEndpoint();
    validateIdleEndpoint(after, plan, templateId);
    validateCreatedRunpodEndpoint(after, plan, templateId);
  } catch (error) {
    try {
      input.runCli(["serverless", "update", endpointId, "--template-id", previousTemplateId]);
      const rolledBack = getEndpoint();
      validateIdleEndpoint(rolledBack, plan, previousTemplateId);
      if (requireRecord(rolledBack, "RunPod rollback response").templateId !== previousTemplateId) {
        throw new Error("RunPod endpoint rollback did not restore the previous template", {
          cause: error,
        });
      }
    } catch (rollbackError) {
      throw new Error("RunPod promotion verification and rollback both failed", {
        cause: rollbackError,
      });
    }
    throw error;
  }
  return { changed: true, endpointId, templateId };
}
