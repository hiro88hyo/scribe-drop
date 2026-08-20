export function verifyStagingResumeInputs(input) {
  const sourceRunId = input.sourceRunId ?? "";
  if (sourceRunId === "") return { recoveredAcceptance: false };
  if (
    !/^[1-9][0-9]*$/u.test(sourceRunId) ||
    input.resumeAcceptanceOnly !== "true" ||
    input.preflightOnly !== "false" ||
    typeof input.candidateCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(input.candidateCommitSha)
  ) {
    throw new Error("Recovered staging acceptance inputs are invalid");
  }
  return { recoveredAcceptance: true, sourceRunId };
}
