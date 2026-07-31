import { runpodCapabilityTokenSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export interface CapabilityToken {
  readonly hash: string;
  readonly raw: string;
}

export type CapabilityRandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): Uint8Array | undefined {
  const parsed = sha256HexSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * 2;
    bytes[index] = Number.parseInt(parsed.data.slice(offset, offset + 2), 16);
  }
  return bytes;
}

export async function hashCapabilityToken(rawToken: string): Promise<string> {
  const token = runpodCapabilityTokenSchema.parse(rawToken);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeHex(new Uint8Array(digest));
}

export async function createCapabilityToken(
  randomBytes: CapabilityRandomBytes = defaultRandomBytes,
): Promise<CapabilityToken> {
  const random = randomBytes(32);
  if (random.byteLength !== 32) {
    throw new Error("Capability random source returned an invalid byte length");
  }
  const raw = runpodCapabilityTokenSchema.parse(encodeBase64Url(random));
  return {
    hash: await hashCapabilityToken(raw),
    raw,
  };
}

export function timingSafeHashEqual(expectedHash: string, observedHash: string): boolean {
  const expected = decodeHex(expectedHash);
  const observed = decodeHex(observedHash);
  if (expected === undefined || observed === undefined) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (expected[index] ?? 0) ^ (observed[index] ?? 0);
  }
  return difference === 0;
}
