import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createRunpodWorkerProvenance } from "./runpod-worker-provenance.mjs";

const [imageReferencePath, outputPath] = process.argv.slice(2);

try {
  if (imageReferencePath === undefined || outputPath === undefined || process.argv.length !== 4) {
    throw new Error("Usage: create-runpod-worker-provenance <image-reference-path> <output-path>");
  }
  const sourceCommitSha = process.env["REUSABLE_WORKER_SOURCE_SHA"];
  const sourceCandidateRunId = process.env["REUSABLE_WORKER_SOURCE_RUN_ID"];
  const provenance = createRunpodWorkerProvenance({
    candidateCommitSha: process.env["GITHUB_SHA"],
    candidateRunId: process.env["GITHUB_RUN_ID"],
    image: readFileSync(path.resolve(imageReferencePath), "utf8").trim(),
    ...(sourceCommitSha === undefined || sourceCommitSha === "" ? {} : { sourceCommitSha }),
    ...(sourceCandidateRunId === undefined || sourceCandidateRunId === ""
      ? {}
      : { sourceCandidateRunId }),
  });
  writeFileSync(path.resolve(outputPath), `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  console.log(`Created ${provenance.mode} RunPod Worker provenance.`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to create RunPod Worker provenance",
  );
  process.exitCode = 1;
}
