import process from "node:process";

import {
  parseStagingReleaseInputs,
  stagingReleaseResources,
  verifyStagingReleaseInputs,
} from "./staging-release-inputs.mjs";

const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
if (
  typeof token !== "string" ||
  !/^[\x21-\x7e]{20,8192}$/u.test(token) ||
  process.argv.length !== 2
) {
  throw new Error("Staging release input verifier authentication is missing or invalid");
}

async function readGoogleJson(url, label) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-goog-user-project": stagingReleaseResources.projectId,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (response.status !== 200 || text.length > 512 * 1024) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

try {
  parseStagingReleaseInputs(process.env);
  const encodedRuntimeAccount = encodeURIComponent(stagingReleaseResources.runtimeServiceAccount);
  const [service, runtimeServiceAccount, primarySecretVersion] = await Promise.all([
    readGoogleJson(
      `https://run.googleapis.com/v2/projects/${stagingReleaseResources.projectId}/locations/${stagingReleaseResources.region}/services/${stagingReleaseResources.serviceName}`,
      "Staging controller Service read-back",
    ),
    readGoogleJson(
      `https://iam.googleapis.com/v1/projects/${stagingReleaseResources.projectId}/serviceAccounts/${encodedRuntimeAccount}`,
      "Staging runtime service account read-back",
    ),
    readGoogleJson(
      `https://secretmanager.googleapis.com/v1/projects/${stagingReleaseResources.projectId}/secrets/${stagingReleaseResources.secretName}/versions/${process.env.SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION ?? "invalid"}`,
      "Staging controller HMAC secret version read-back",
    ),
  ]);
  console.log(
    JSON.stringify(
      verifyStagingReleaseInputs(process.env, {
        primarySecretVersion,
        runtimeServiceAccount,
        service,
      }),
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Staging release input verification failed",
  );
  process.exitCode = 1;
}
