import {
  createRunpodTemplateArguments,
  hasOnlyKnownRunpodDefaultPortDrift,
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

function requireWorkers(value) {
  return value === undefined ? [] : requireArray(value, "RunPod endpoint workers");
}

function validateNoActiveWorkers(untrustedWorkers) {
  const terminalStatuses = new Set(["EXITED", "TERMINATED"]);
  const workers = requireWorkers(untrustedWorkers);
  if (
    workers.some((untrustedWorker) => {
      const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
      return !terminalStatuses.has(worker.desiredStatus);
    })
  ) {
    throw new Error("RunPod endpoint has active or unrecognized workers and cannot be promoted");
  }
  return workers;
}

function candidateWorkersMatch(untrustedWorkers, templateId, image) {
  const workers = validateNoActiveWorkers(untrustedWorkers);
  return workers.every((untrustedWorker) => {
    const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
    return worker.templateId === templateId && worker.imageName === image;
  });
}

function validateCandidateWorkers(untrustedWorkers, templateId, image) {
  const workers = validateNoActiveWorkers(untrustedWorkers);
  if (
    workers.some((untrustedWorker) => {
      const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
      return worker.templateId !== templateId || worker.imageName !== image;
    })
  ) {
    throw new Error("RunPod endpoint retains a worker from a different template or image");
  }
  return workers;
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

function validateDrainedEndpoint(untrustedEndpoint, plan, effectiveTemplateId) {
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  const workers = requireWorkers(endpoint.workers);
  if (
    (endpoint.workersMin ?? 0) !== 0 ||
    (endpoint.workersMax ?? 0) !== 0 ||
    workers.length !== 0
  ) {
    throw new Error("RunPod endpoint did not drain all workers");
  }
  validateCreatedRunpodEndpoint(
    {
      ...endpoint,
      templateId: effectiveTemplateId,
      workersMax: plan.endpoint.workersMax,
    },
    plan,
    effectiveTemplateId,
  );
  return requireResourceId(endpoint.templateId, "RunPod current template ID");
}

async function setWorkersMaxAndReadBack(input, workersMax, getEndpoint, validate) {
  if (typeof input.setEndpointWorkersMax !== "function") {
    throw new Error("RunPod endpoint worker drain is unavailable");
  }
  try {
    await input.setEndpointWorkersMax({
      endpointId: input.endpointId,
      workersMax,
    });
  } catch {
    // A lost mutation response has an unknown outcome. The exact read-back
    // below is authoritative, so the mutation itself is never retried.
  }
  const endpoint = getEndpoint();
  validate(endpoint);
  return endpoint;
}

function matchingTemplates(templates, name) {
  return templates.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.name === name,
  );
}

async function listTemplates(input) {
  if (typeof input.listTemplates !== "function") {
    throw new Error("RunPod template listing is unavailable");
  }
  return input.listTemplates();
}

async function getOrCreateTemplateResponse(plan, input) {
  const matches = matchingTemplates(
    requireArray(await listTemplates(input), "RunPod template list"),
    plan.template.name,
  );
  if (matches.length > 1) {
    throw new Error("Multiple RunPod templates match the candidate plan");
  }
  if (matches.length === 1) {
    const summary = requireRecord(matches[0], "RunPod template summary");
    const templateId = requireResourceId(summary.id, "RunPod template ID");
    return input.runCli(["template", "get", templateId]);
  }

  return input.runCli(createRunpodTemplateArguments(plan));
}

export async function verifyRunpodPromotionPreflight(input) {
  const plan = validateRunpodPlan(input.plan, input.environment);
  const endpointId = requireResourceId(input.endpointId, "RunPod endpoint ID");
  const matches = matchingTemplates(
    requireArray(await listTemplates(input), "RunPod template list"),
    plan.template.name,
  );
  if (matches.length > 1) {
    throw new Error("Multiple RunPod templates match the candidate plan");
  }

  let candidateTemplateId;
  let candidateTemplatePortsRequireNormalization = false;
  if (matches.length === 1) {
    const summary = requireRecord(matches[0], "RunPod template summary");
    const templateId = requireResourceId(summary.id, "RunPod template ID");
    const candidate = input.runCli(["template", "get", templateId]);
    if (hasOnlyKnownRunpodDefaultPortDrift(candidate, plan)) {
      candidateTemplateId = requireResourceId(
        requireRecord(candidate, "RunPod template response").id,
        "RunPod template ID",
      );
      candidateTemplatePortsRequireNormalization = true;
    } else {
      candidateTemplateId = validateCreatedRunpodTemplate(candidate, plan);
    }
  }

  const endpoint = input.runCli([
    "serverless",
    "get",
    endpointId,
    "--include-template",
    "--include-workers",
  ]);
  const currentTemplateId = requireResourceId(
    requireRecord(endpoint, "RunPod endpoint response").templateId,
    "RunPod current template ID",
  );
  validateIdleEndpoint(endpoint, plan, candidateTemplateId ?? currentTemplateId);
  const candidateIsAttached =
    candidateTemplateId !== undefined && currentTemplateId === candidateTemplateId;
  if (candidateIsAttached) {
    const workers = validateCandidateWorkers(
      endpoint.workers,
      candidateTemplateId,
      plan.template.image,
    );
    if (input.requireCandidateWorker === true && workers.length === 0) {
      throw new Error("RunPod candidate worker evidence is missing");
    }
  } else if (input.requireCandidateWorker === true) {
    throw new Error("RunPod candidate template is not attached");
  }
  if (candidateTemplatePortsRequireNormalization && currentTemplateId === candidateTemplateId) {
    throw new Error("RunPod candidate template with default ports is already attached");
  }
  return {
    candidateTemplateExists: candidateTemplateId !== undefined,
    candidateTemplatePortsRequireNormalization,
    endpointId,
  };
}

export async function promoteRunpodCandidate(input) {
  const plan = validateRunpodPlan(input.plan, input.environment);
  const endpointId = requireResourceId(input.endpointId, "RunPod endpoint ID");
  const getEndpoint = () =>
    input.runCli(["serverless", "get", endpointId, "--include-template", "--include-workers"]);
  const candidate = await getOrCreateTemplateResponse(plan, input);
  let templateId;
  if (hasOnlyKnownRunpodDefaultPortDrift(candidate, plan)) {
    templateId = requireResourceId(
      requireRecord(candidate, "RunPod template response").id,
      "RunPod template ID",
    );
    const endpointBeforeNormalization = getEndpoint();
    const currentTemplateId = requireResourceId(
      requireRecord(endpointBeforeNormalization, "RunPod endpoint response").templateId,
      "RunPod current template ID",
    );
    validateIdleEndpoint(endpointBeforeNormalization, plan, currentTemplateId);
    if (currentTemplateId === templateId) {
      throw new Error("RunPod candidate template with default ports is already attached");
    }
    if (typeof input.clearTemplatePorts !== "function") {
      throw new Error("RunPod template port normalization is unavailable");
    }

    try {
      await input.clearTemplatePorts(templateId);
    } catch {
      // A lost mutation response has an unknown outcome. The exact read-back
      // below is authoritative, so the mutation itself is never retried.
    }
    try {
      templateId = validateCreatedRunpodTemplate(
        input.runCli(["template", "get", templateId]),
        plan,
      );
    } catch (error) {
      throw new Error("RunPod candidate template port normalization failed", {
        cause: error,
      });
    }
  } else {
    templateId = validateCreatedRunpodTemplate(candidate, plan);
  }
  const before = getEndpoint();
  const previousTemplateId = validateIdleEndpoint(before, plan, templateId);
  const candidateWorkersAreCurrent =
    previousTemplateId === templateId &&
    candidateWorkersMatch(before.workers, templateId, plan.template.image);
  if (previousTemplateId === templateId && candidateWorkersAreCurrent) {
    validateCreatedRunpodEndpoint(before, plan, templateId);
    return { changed: false, endpointId, templateId };
  }
  if (typeof input.setEndpointWorkersMax !== "function") {
    throw new Error("RunPod endpoint worker drain is unavailable");
  }

  const validateDrainedTemplate = (endpoint, expectedTemplateId) => {
    const actualTemplateId = validateDrainedEndpoint(endpoint, plan, expectedTemplateId);
    if (actualTemplateId !== expectedTemplateId) {
      throw new Error("RunPod endpoint template update read-back did not match");
    }
  };
  const restorePreviousEndpoint = async () => {
    let current = getEndpoint();
    validateNoActiveWorkers(requireRecord(current, "RunPod endpoint response").workers);
    let currentTemplateId = requireResourceId(current.templateId, "RunPod current template ID");
    const currentWorkersMax = current.workersMax ?? 0;
    if (
      currentTemplateId === previousTemplateId &&
      currentWorkersMax === plan.endpoint.workersMax
    ) {
      validateIdleEndpoint(current, plan, previousTemplateId);
      return;
    }
    if (currentWorkersMax !== 0) {
      current = await setWorkersMaxAndReadBack(input, 0, getEndpoint, (endpoint) => {
        const actualTemplateId = requireResourceId(
          requireRecord(endpoint, "RunPod endpoint response").templateId,
          "RunPod current template ID",
        );
        validateDrainedTemplate(endpoint, actualTemplateId);
      });
      currentTemplateId = requireResourceId(
        requireRecord(current, "RunPod endpoint response").templateId,
        "RunPod current template ID",
      );
    } else {
      validateDrainedTemplate(current, currentTemplateId);
    }
    if (currentTemplateId !== previousTemplateId) {
      try {
        input.runCli(["serverless", "update", endpointId, "--template-id", previousTemplateId]);
      } catch {
        // The exact read-back below decides whether rollback took effect.
      }
      const restoredTemplate = getEndpoint();
      validateDrainedTemplate(restoredTemplate, previousTemplateId);
    }
    await setWorkersMaxAndReadBack(input, plan.endpoint.workersMax, getEndpoint, (endpoint) => {
      const actualTemplateId = validateIdleEndpoint(endpoint, plan, previousTemplateId);
      if (actualTemplateId !== previousTemplateId) {
        throw new Error("RunPod endpoint rollback did not restore the previous template");
      }
    });
  };

  try {
    await setWorkersMaxAndReadBack(input, 0, getEndpoint, (endpoint) => {
      validateDrainedTemplate(endpoint, previousTemplateId);
    });
    if (previousTemplateId !== templateId) {
      try {
        input.runCli(["serverless", "update", endpointId, "--template-id", templateId]);
      } catch {
        // The exact read-back below decides whether promotion took effect.
      }
      const switched = getEndpoint();
      validateDrainedTemplate(switched, templateId);
    }
    await setWorkersMaxAndReadBack(input, plan.endpoint.workersMax, getEndpoint, (endpoint) => {
      const actualTemplateId = validateIdleEndpoint(endpoint, plan, templateId);
      if (actualTemplateId !== templateId) {
        throw new Error("RunPod endpoint template update read-back did not match");
      }
      validateCreatedRunpodEndpoint(endpoint, plan, templateId);
      validateCandidateWorkers(endpoint.workers, templateId, plan.template.image);
    });
  } catch (error) {
    try {
      await restorePreviousEndpoint();
    } catch (rollbackError) {
      throw new Error("RunPod promotion verification and rollback both failed", {
        cause: rollbackError,
      });
    }
    throw error;
  }
  return { changed: true, endpointId, templateId };
}
