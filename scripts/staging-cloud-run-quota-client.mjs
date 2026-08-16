const PROJECT_NUMBER = "601035271372";
const QUOTA_ID = "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion";
const SERVICE = "run.googleapis.com";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;

export const stagingL4QuotaUrl =
  `https://cloudquotas.googleapis.com/v1/projects/${PROJECT_NUMBER}` +
  `/locations/global/services/${SERVICE}/quotaInfos/${QUOTA_ID}`;

export async function readStagingL4Quota(token, fetchImplementation = fetch) {
  if (typeof token !== "string" || !tokenPattern.test(token)) {
    throw new Error("Staging L4 quota authentication is missing or invalid");
  }
  const response = await fetchImplementation(stagingL4QuotaUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (response.status !== 200 || body.length > 512 * 1024) {
    throw new Error(`Staging L4 quota read failed: ${response.status}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Staging L4 quota response was invalid");
  }
}
