function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireJob(jobs, name, conclusion) {
  const matches = jobs.filter((job) => job?.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.status !== "completed" ||
    matches[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Source staging ${name} job did not finish with ${conclusion}`);
  }
  return matches[0];
}

function requireStep(job, name, conclusion) {
  const steps = Array.isArray(job.steps) ? job.steps.filter((step) => step?.name === name) : [];
  if (
    steps.length !== 1 ||
    steps[0]?.status !== "completed" ||
    steps[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Source staging step ${name} did not finish with ${conclusion}`);
  }
}

function requirePromotionMode(jobs) {
  const conclusions = [
    "Apply candidate D1 migrations",
    "Promote exact candidate Pages deployment",
    "Promote R2, RunPod, and Orchestrator",
  ].map((name) => {
    const matches = jobs.filter((job) => job?.name === name);
    if (matches.length !== 1 || matches[0]?.status !== "completed") {
      throw new Error(`Source staging ${name} job is invalid`);
    }
    return matches[0].conclusion;
  });
  if (
    !new Set(["success", "skipped"]).has(conclusions[0]) ||
    !conclusions.every((conclusion) => conclusion === conclusions[0])
  ) {
    throw new Error("Source staging promotion jobs are inconsistent");
  }
}

export function verifyStagingAcceptanceResume(runValue, jobsValue, expected) {
  const run = requireRecord(runValue, "Source staging run");
  const jobsEnvelope = requireRecord(jobsValue, "Source staging jobs");
  const jobs = jobsEnvelope.jobs;
  if (
    !Array.isArray(jobs) ||
    !Number.isSafeInteger(jobsEnvelope.total_count) ||
    jobsEnvelope.total_count !== jobs.length
  ) {
    throw new Error("Source staging jobs are incomplete");
  }
  if (
    String(run.id) !== expected.sourceRunId ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/deploy-staging-candidate.yml" ||
    run.head_branch !== expected.releaseBranch ||
    run.run_attempt !== 1 ||
    run.repository?.full_name !== expected.repository ||
    run.display_title !== `Deploy candidate from run ${expected.candidateRunId} to staging`
  ) {
    throw new Error("Source staging workflow identity is invalid");
  }
  if (typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/u.test(run.head_sha)) {
    throw new Error("Source staging workflow commit is invalid");
  }

  requireJob(jobs, "Verify candidate and all remote prerequisites", "success");
  requirePromotionMode(jobs);
  const acceptance = requireJob(
    jobs,
    "Verify live resources and run real staging acceptance",
    "failure",
  );
  for (const name of [
    "Verify candidate and live resource read-back",
    "Verify authenticated data plane, then run real staging M4A lifecycle",
    "Preserve only unresolved fixture identity for automatic recovery",
  ]) {
    requireStep(acceptance, name, "success");
  }
  requireStep(
    acceptance,
    "Verify exact-one Cloud Run cleanup and provider storage convergence",
    "failure",
  );
  for (const name of [
    "Disable staging controller authorization after cleanup",
    "Restore RunPod selection while preserving the Cloud Run reaper",
    "Verify final disabled zero state before issuing acceptance",
    "Issue short-lived staging acceptance",
    "Upload immutable staging acceptance",
  ]) {
    requireStep(acceptance, name, "skipped");
  }

  const recoveryMatches = jobs.filter(
    (job) => job?.name === "Converge a failed staging acceptance to the safe state",
  );
  const recovery = recoveryMatches[0];
  if (
    recoveryMatches.length !== 1 ||
    recovery?.status !== "completed" ||
    !new Set(["success", "failure"]).has(recovery.conclusion)
  ) {
    throw new Error("Source staging recovery job is invalid");
  }
  for (const name of [
    "Wait for the deployed reaper and Cloud Run resources to converge",
    "Disable only this failed run's staging controller authorization",
    "Reactivate RunPod only after Cloud Run is disabled and empty",
    "Verify recovered staging safety without issuing acceptance",
  ]) {
    requireStep(recovery, name, "success");
  }
  requireStep(recovery, "Reject any incomplete automatic recovery action", recovery.conclusion);

  return {
    headSha: run.head_sha,
    recoveryRequiresLiveReverification: recovery.conclusion === "failure",
    sourceRunId: expected.sourceRunId,
  };
}
