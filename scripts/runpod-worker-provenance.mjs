const commitShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const imagePattern =
  /^ghcr\.io\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/scribe-drop-runpod-worker@sha256:([0-9a-f]{64})$/u;
const runIdPattern = /^[1-9][0-9]*$/u;

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function createRunpodWorkerProvenance(input) {
  const candidateCommitSha = requirePattern(
    input.candidateCommitSha,
    commitShaPattern,
    "Candidate commit",
  );
  const candidateRunId = requirePattern(input.candidateRunId, runIdPattern, "Candidate run ID");
  const image = requirePattern(input.image, imagePattern, "RunPod Worker image");
  const imageMatch = imagePattern.exec(image);
  if (imageMatch?.[1] === undefined || !digestPattern.test(imageMatch[1])) {
    throw new Error("RunPod Worker image digest is invalid");
  }
  const reused = input.sourceCommitSha !== undefined || input.sourceCandidateRunId !== undefined;
  const sourceCommitSha = requirePattern(
    reused ? input.sourceCommitSha : candidateCommitSha,
    commitShaPattern,
    "Worker source commit",
  );
  const sourceCandidateRunId = requirePattern(
    reused ? input.sourceCandidateRunId : candidateRunId,
    runIdPattern,
    "Worker source candidate run ID",
  );

  return {
    schemaVersion: 1,
    mode: reused ? "reused" : "built",
    candidate: {
      commitSha: candidateCommitSha,
      runId: candidateRunId,
    },
    image: {
      digest: imageMatch[1],
    },
    source: {
      commitSha: sourceCommitSha,
      candidateRunId: sourceCandidateRunId,
    },
    currentRunVerification: {
      offlineContainerCheck: true,
      sbomGenerated: true,
      vulnerabilityScan: true,
    },
  };
}
