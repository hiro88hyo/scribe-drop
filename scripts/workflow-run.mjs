const commitShaPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const releaseBranchPattern =
  /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function validateTrustedWorkflowRun(value, expected) {
  const run = requireRecord(value, "GitHub workflow run");
  const repository = requireRecord(run.repository, "GitHub workflow run repository");
  const expectedRunId = requireString(expected.runId, "Expected workflow run ID");
  if (!runIdPattern.test(expectedRunId) || String(run.id) !== expectedRunId) {
    throw new Error("GitHub workflow run ID does not match");
  }
  const expectedCommitSha = requireString(expected.commitSha, "Expected workflow commit");
  if (!commitShaPattern.test(expectedCommitSha) || run.head_sha !== expectedCommitSha) {
    throw new Error("GitHub workflow run commit does not match");
  }
  const branch = requireString(run.head_branch, "GitHub workflow run branch");
  if (!releaseBranchPattern.test(branch) || branch !== expected.branch) {
    throw new Error("GitHub workflow run branch does not match");
  }
  if (
    run.path !== expected.workflowPath ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    repository.full_name !== expected.repository
  ) {
    throw new Error("GitHub workflow run is not a trusted successful run");
  }
  return {
    branch,
    commitSha: expectedCommitSha,
    runId: expectedRunId,
    workflowPath: expected.workflowPath,
  };
}
