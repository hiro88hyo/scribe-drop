import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function resolveCandidateDirectory(
  candidateDirectory: string,
  rootDirectory = repositoryRoot,
): string {
  return path.isAbsolute(candidateDirectory)
    ? path.normalize(candidateDirectory)
    : path.resolve(rootDirectory, candidateDirectory);
}

export function readCandidateFixture(
  candidateDirectory: string,
  rootDirectory = repositoryRoot,
): Buffer {
  const resolvedCandidateDirectory = resolveCandidateDirectory(candidateDirectory, rootDirectory);
  const metadata = JSON.parse(
    readFileSync(
      path.join(resolvedCandidateDirectory, "acceptance-fixtures", "metadata.json"),
      "utf8",
    ),
  ) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("schemaVersion" in metadata) ||
    metadata.schemaVersion !== 1 ||
    !("filename" in metadata) ||
    metadata.filename !== "android-aac.m4a" ||
    !("mediaType" in metadata) ||
    metadata.mediaType !== "audio/mp4a-latm" ||
    !("synthetic" in metadata) ||
    metadata.synthetic !== true
  ) {
    throw new Error("Release candidate acceptance fixture metadata is invalid");
  }
  return readFileSync(
    path.join(resolvedCandidateDirectory, "acceptance-fixtures", "android-aac.m4a"),
  );
}
