import { appendFileSync } from "node:fs";
import process from "node:process";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const SERVICE = "scribe-drop-production-gpu-controller";
const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
const githubEnvironmentPath = process.env.GITHUB_ENV;
if (
  typeof token !== "string" ||
  !/^[\x21-\x7e]{20,8192}$/u.test(token) ||
  typeof githubEnvironmentPath !== "string" ||
  githubEnvironmentPath.length === 0 ||
  process.argv.length !== 2
) {
  throw new Error("Production controller origin export input is invalid");
}

try {
  const response = await fetch(
    `https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "x-goog-user-project": PROJECT_ID,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response.json();
  const uri = body?.uri;
  if (response.status !== 200 || typeof uri !== "string") {
    throw new Error("Production controller Service read failed");
  }
  const url = new URL(uri);
  if (
    url.protocol !== "https:" ||
    url.origin !== uri ||
    !/^scribe-drop-production-gpu-controller-[0-9]+\.asia-southeast1\.run\.app$/u.test(url.hostname)
  ) {
    throw new Error("Production controller origin is invalid");
  }
  appendFileSync(
    githubEnvironmentPath,
    `SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_ORIGIN=${uri}\n`,
    "utf8",
  );
  console.log("Exported the exact production controller origin.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Controller origin export failed");
  process.exitCode = 1;
}
