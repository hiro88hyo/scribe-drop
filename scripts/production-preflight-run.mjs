import { validateTrustedWorkflowRun } from "./workflow-run.mjs";

function requireJob(jobs, name, conclusion) {
  const matches = jobs.filter((job) => job?.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.status !== "completed" ||
    matches[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Production preflight ${name} job did not finish with ${conclusion}`);
  }
  return matches[0];
}

function requireStep(job, name, conclusion) {
  const matches = Array.isArray(job.steps) ? job.steps.filter((step) => step?.name === name) : [];
  if (
    matches.length !== 1 ||
    matches[0]?.status !== "completed" ||
    matches[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Production preflight step ${name} did not finish with ${conclusion}`);
  }
}

export function verifyProductionPreflightRun(run, jobsEnvelope, expected) {
  validateTrustedWorkflowRun(run, {
    branch: expected.releaseBranch,
    commitSha: expected.workflowCommitSha,
    repository: expected.repository,
    runId: expected.preflightRunId,
    workflowPath: ".github/workflows/deploy-production-candidate.yml",
  });
  if (
    run.run_attempt !== 1 ||
    run.display_title !== `Production preflight from staging run ${expected.stagingRunId}` ||
    !Array.isArray(jobsEnvelope?.jobs) ||
    jobsEnvelope.total_count !== jobsEnvelope.jobs.length
  ) {
    throw new Error("Production preflight workflow identity is invalid");
  }
  const verification = requireJob(
    jobsEnvelope.jobs,
    "Verify immutable candidate, acceptance, and operation inputs",
    "success",
  );
  for (const name of [
    "Validate bounded production operation inputs",
    "Verify previous production release entry before cutover",
    "Validate release and staging run identities",
    "Download and inspect immutable staging evidence",
    "Download and verify both exact candidates",
  ]) {
    requireStep(verification, name, "success");
  }
  requireStep(verification, "Verify immutable cutover evidence for finalize", "skipped");
  requireStep(
    verification,
    "Verify successful mutation-free production preflight before cutover",
    "skipped",
  );

  const cutover = requireJob(
    jobsEnvelope.jobs,
    "Cut over safely and open exactly one production smoke slot",
    "success",
  );
  for (const name of [
    "Download acceptance and export exact candidate identity",
    "Download and re-verify exact candidates",
    "Export verified previous production upgrade entry",
    "Build verifier and strictly read production foundation",
    "Render disabled preflight configuration",
    "Verify accepted production environment policy before external access",
    "Verify every external control plane before production mutation",
  ]) {
    requireStep(cutover, name, "success");
  }
  for (const name of [
    "Apply candidate migrations and reviewed R2 policies",
    "Promote exact rollback-compatible RunPod image without execution",
    "Deploy exact application candidate with admission paused",
    "Drain old provider before changing new-attempt selection",
    "Quiesce the expired previous production authorization",
    "Deploy bounded controller after admission drain",
    "Select Cloud Run while keeping admission paused",
    "Verify exact-one L4 authorization and activate admission",
    "Record immutable cutover evidence",
    "Upload immutable cutover evidence",
  ]) {
    requireStep(cutover, name, "skipped");
  }
  requireJob(
    jobsEnvelope.jobs,
    "Verify production smoke and open the reviewed operating window",
    "skipped",
  );
  return { preflightRunId: expected.preflightRunId, stagingRunId: expected.stagingRunId };
}
