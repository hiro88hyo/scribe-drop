import { createUlid as createDomainUlid, type RandomBytes } from "@scribe-drop/domain";

export type { RandomBytes } from "@scribe-drop/domain";

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function createUlid(
  timestampMilliseconds: number,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  return createDomainUlid(timestampMilliseconds, randomBytes);
}
