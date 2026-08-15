function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function verifyStagingDispatchUniqueness(untrusted, input) {
  const currentRunId = requireString(input.currentRunId, /^[1-9][0-9]*$/u, "Staging run ID");
  const commit = requireString(input.commit, /^[a-f0-9]{40}$/u, "Staging commit");
  if (input.runAttempt !== "1") {
    throw new Error("Staging acceptance jobs must not be re-run");
  }
  if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) {
    throw new Error("Staging workflow run inventory is invalid");
  }
  const runs = untrusted.workflow_runs;
  if (
    !Array.isArray(runs) ||
    !Number.isSafeInteger(untrusted.total_count) ||
    untrusted.total_count !== runs.length
  ) {
    throw new Error("This commit already has another staging workflow dispatch");
  }
  const preflightTitle = /^Preflight candidate from run [1-9][0-9]* to staging$/u;
  for (const candidate of runs.filter(
    (run) => typeof run?.display_title === "string" && preflightTitle.test(run.display_title),
  )) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      candidate.head_sha !== commit ||
      candidate.event !== "workflow_dispatch" ||
      candidate.path !== ".github/workflows/deploy-staging-candidate.yml"
    ) {
      throw new Error("Mutation-free staging preflight identity does not match");
    }
  }
  const deploymentRuns = runs.filter(
    (run) => typeof run?.display_title !== "string" || !preflightTitle.test(run.display_title),
  );
  if (deploymentRuns.length !== 1) {
    throw new Error("This commit already has another staging workflow dispatch");
  }
  const run = deploymentRuns[0];
  if (
    typeof run !== "object" ||
    run === null ||
    Array.isArray(run) ||
    String(run.id) !== currentRunId ||
    run.head_sha !== commit ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/deploy-staging-candidate.yml"
  ) {
    throw new Error("Current staging workflow dispatch identity does not match");
  }
  return { priorDispatchCount: 0, runAttempt: 1 };
}
