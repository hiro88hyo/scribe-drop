const PROJECT_NUMBER = "601035271372";
const REGION = "asia-southeast1";
const QUOTA_ID = "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion";
const QUOTA_METRIC = "run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy";

export const stagingSmokeCostReview = Object.freeze({
  exchangeRateCeilingJpyPerUsd: 200,
  gpuUsdPerSecond: 0.0001867,
  memoryGiB: 16,
  memoryUsdPerGibSecond: 0.000002,
  networkAllowanceMultiplier: 1.1,
  taxMultiplier: 1.1,
  timeoutSeconds: 3300,
  vcpu: 4,
  vcpuUsdPerSecond: 0.000018,
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function verifyStagingL4Quota(untrustedQuota) {
  const quota =
    typeof untrustedQuota === "object" && untrustedQuota !== null && !Array.isArray(untrustedQuota)
      ? untrustedQuota
      : {};
  const regionEntries = Array.isArray(quota.dimensionsInfos)
    ? quota.dimensionsInfos.filter((entry) => entry?.dimensions?.region === REGION)
    : [];
  const regionEntry = regionEntries.length === 1 ? regionEntries[0] : undefined;
  const effectiveLimit = Number(regionEntry?.details?.value);
  if (
    quota.containerType !== "PROJECT" ||
    !same(quota.dimensions, ["region"]) ||
    quota.metric !== QUOTA_METRIC ||
    quota.metricUnit !== "1" ||
    quota.name !==
      `projects/${PROJECT_NUMBER}/locations/global/services/run.googleapis.com/quotaInfos/${QUOTA_ID}` ||
    quota.quotaId !== QUOTA_ID ||
    quota.service !== "run.googleapis.com" ||
    !Array.isArray(regionEntry?.applicableLocations) ||
    !regionEntry.applicableLocations.includes(REGION) ||
    !Number.isInteger(effectiveLimit) ||
    effectiveLimit < 1
  ) {
    throw new Error("Staging Singapore no-zonal L4 quota does not fit exact one execution");
  }
  return { effectiveLimit, exactOneFits: true, metric: QUOTA_METRIC, region: REGION };
}

export function stagingSmokeWorstCaseJpy(review = stagingSmokeCostReview) {
  const computeUsdPerSecond =
    review.vcpu * review.vcpuUsdPerSecond +
    review.memoryGiB * review.memoryUsdPerGibSecond +
    review.gpuUsdPerSecond;
  return Math.ceil(
    computeUsdPerSecond *
      review.timeoutSeconds *
      review.exchangeRateCeilingJpyPerUsd *
      review.networkAllowanceMultiplier *
      review.taxMultiplier,
  );
}

export function verifyStagingPaidManifest(manifest, expectedWorkerImage) {
  const task = manifest?.template?.template;
  const containers = task?.containers;
  const container =
    Array.isArray(containers) && containers.length === 1 ? containers[0] : undefined;
  const environment = new Map(
    Array.isArray(container?.env) ? container.env.map(({ name, value }) => [name, value]) : [],
  );
  if (
    manifest?.binaryAuthorization?.useDefault !== true ||
    !same(manifest?.labels, {
      "scribe-drop-environment": "staging",
      "scribe-drop-policy": "cloud-run-jobs-l4-v1",
    }) ||
    manifest?.template?.taskCount !== 1 ||
    manifest?.template?.parallelism !== 1 ||
    container?.name !== "worker" ||
    container?.image !== expectedWorkerImage ||
    !same(container?.command, ["python", "-m", "scribe_drop_worker.one_shot"]) ||
    environment.size !== 8 ||
    environment.get("APP_ENV") !== "staging" ||
    environment.get("SCRIBE_DROP_EXECUTION_POLICY") !== "cloud_run_jobs_l4_v1" ||
    !same(container?.resources?.limits, {
      cpu: "4",
      memory: "16Gi",
      "nvidia.com/gpu": "1",
    }) ||
    !same(container?.volumeMounts, [{ mountPath: "/tmp", name: "scratch" }]) ||
    !same(task?.volumes, [{ emptyDir: { medium: "MEMORY", sizeLimit: "3Gi" }, name: "scratch" }]) ||
    task?.timeout !== "3300s" ||
    task?.executionEnvironment !== "EXECUTION_ENVIRONMENT_GEN2" ||
    !same(task?.nodeSelector, { accelerator: "nvidia-l4" }) ||
    task?.maxRetries !== 0 ||
    task?.gpuZonalRedundancyDisabled !== true
  ) {
    throw new Error("Staging paid Job manifest does not match the Phase 15 fixed policy");
  }
  return {
    cpu: 4,
    gpu: 1,
    maxRetries: 0,
    memoryGiB: 16,
    parallelism: 1,
    taskCount: 1,
    timeoutSeconds: 3300,
  };
}

export function verifyStagingPaidReadiness({ manifest, quota, workerImage }) {
  const costJpy = stagingSmokeWorstCaseJpy();
  if (costJpy !== 233 || costJpy > 250) {
    throw new Error("Staging exact-one worst-case cost exceeds the 250 JPY authorization");
  }
  return {
    authorizationJpy: 250,
    costJpy,
    manifest: verifyStagingPaidManifest(manifest, workerImage),
    quota: verifyStagingL4Quota(quota),
  };
}
