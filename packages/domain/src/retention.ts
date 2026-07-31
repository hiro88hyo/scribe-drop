export const R2_CAPABILITY_TTL_SECONDS = 2 * 60 * 60;
export const USER_DELETION_CAPABILITY_GRACE_SECONDS = 5 * 60;

export function deletionNotBeforeMilliseconds(
  requestedAtMilliseconds: number,
  latestCapabilityIssuedAtMilliseconds: number | null,
): number {
  if (!Number.isSafeInteger(requestedAtMilliseconds) || requestedAtMilliseconds < 0) {
    throw new Error("Deletion request time must be a non-negative safe integer");
  }
  if (
    latestCapabilityIssuedAtMilliseconds !== null &&
    (!Number.isSafeInteger(latestCapabilityIssuedAtMilliseconds) ||
      latestCapabilityIssuedAtMilliseconds < 0)
  ) {
    throw new Error("Capability issue time must be a non-negative safe integer");
  }
  if (latestCapabilityIssuedAtMilliseconds === null) {
    return requestedAtMilliseconds;
  }
  return Math.max(
    requestedAtMilliseconds,
    latestCapabilityIssuedAtMilliseconds +
      (R2_CAPABILITY_TTL_SECONDS + USER_DELETION_CAPABILITY_GRACE_SECONDS) * 1_000,
  );
}
