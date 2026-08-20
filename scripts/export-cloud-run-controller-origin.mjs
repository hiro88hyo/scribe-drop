import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "scribe-drop";
const PROJECT_NUMBER = "601035271372";
const REGION = "asia-southeast1";
const SERVICE = "scribe-drop-production-gpu-controller";
const SERVICE_NAME = `projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}`;
const EXPECTED_ORIGIN = `https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;

export function selectProductionControllerOrigin(body) {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    body.name !== SERVICE_NAME ||
    !Array.isArray(body.urls) ||
    !body.urls.includes(EXPECTED_ORIGIN)
  ) {
    throw new Error("Production controller origin is invalid");
  }
  return EXPECTED_ORIGIN;
}

async function main() {
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
    if (response.status !== 200) {
      throw new Error("Production controller Service read failed");
    }
    const origin = selectProductionControllerOrigin(body);
    appendFileSync(
      githubEnvironmentPath,
      `SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_ORIGIN=${origin}\n`,
      "utf8",
    );
    console.log("Exported the exact production controller origin.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Controller origin export failed");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  typeof invokedPath === "string" &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  await main();
}
