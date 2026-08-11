import { decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { z } from "zod";

import type {
  GoogleIdentityVerifier,
  RuntimeClock,
  VerifiedGoogleIdentity,
} from "./cloud-run-runtime-service.js";

export const GOOGLE_OAUTH_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs" as const;

const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 30_000;

const serviceAccountEmailSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u);

const protectedHeaderSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().regex(/^[a-f0-9]{40}$/u),
    typ: z.literal("JWT").optional(),
  })
  .strict();

const googleJwkSchema = z
  .object({
    alg: z.literal("RS256"),
    e: z.literal("AQAB"),
    kid: z.string().regex(/^[a-f0-9]{40}$/u),
    kty: z.literal("RSA"),
    n: z
      .string()
      .length(342)
      .regex(/^[A-Za-z0-9_-]{342}$/u),
    use: z.literal("sig"),
  })
  .strict();

const googleJwksSchema = z
  .object({ keys: z.array(googleJwkSchema).min(1).max(10) })
  .strict()
  .superRefine((value, context) => {
    const keyIds = new Set<string>();
    for (const key of value.keys) {
      if (keyIds.has(key.kid)) {
        context.addIssue({ code: "custom", message: "duplicate Google JWKS key ID" });
      }
      keyIds.add(key.kid);
    }
  });

const googleIdentityClaimsSchema = z.object({
  aud: z.string().min(1).max(2048),
  azp: z.string().regex(/^\d{6,32}$/u),
  email: serviceAccountEmailSchema,
  email_verified: z.literal(true),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  iss: z.literal("https://accounts.google.com"),
  sub: z.string().regex(/^\d{6,32}$/u),
});

interface CachedGoogleJwks {
  readonly expiresAtMs: number;
  readonly fetchedAtMs: number;
  readonly keys: readonly JWK[];
}

export interface GoogleIdentityVerifierConfiguration {
  readonly clockSkewMs: number;
  readonly fetchTimeoutMs: number;
  readonly issuer: "https://accounts.google.com";
}

export interface GoogleIdentityVerifierPorts {
  readonly clock: RuntimeClock;
  readonly fetch: typeof fetch;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaxAge(value: string | null): number {
  if (value === null) throw new Error("Google JWKS response was rejected");
  const directive = value
    .split(",")
    .map((part) => part.trim())
    .find((part) => /^max-age=\d+$/iu.test(part));
  if (directive === undefined) throw new Error("Google JWKS response was rejected");
  const seconds = Number(directive.slice("max-age=".length));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Google JWKS response was rejected");
  }
  return Math.min(seconds * 1000, MAX_JWKS_CACHE_MS);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/u.test(response.headers.get("content-type") ?? "")) {
    throw new Error("Google JWKS response was rejected");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JWKS_BYTES)) {
    throw new Error("Google JWKS response was rejected");
  }
  if (response.body === null) throw new Error("Google JWKS response was rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result: unknown = await reader.read();
    if (!isRecord(result) || typeof result["done"] !== "boolean") {
      throw new Error("Google JWKS response was rejected");
    }
    if (result["done"]) break;
    const value = result["value"];
    if (!(value instanceof Uint8Array)) throw new Error("Google JWKS response was rejected");
    total += value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel();
      throw new Error("Google JWKS response was rejected");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("Google JWKS response was rejected");
  }
}

export class GoogleOidcIdentityVerifier implements GoogleIdentityVerifier {
  readonly #configuration: GoogleIdentityVerifierConfiguration;
  readonly #ports: GoogleIdentityVerifierPorts;
  #cache: CachedGoogleJwks | null = null;
  #refresh: Promise<CachedGoogleJwks> | null = null;

  constructor(
    configuration: GoogleIdentityVerifierConfiguration,
    ports: GoogleIdentityVerifierPorts,
  ) {
    if (
      configuration.clockSkewMs < 0 ||
      configuration.clockSkewMs > 30_000 ||
      configuration.fetchTimeoutMs <= 0 ||
      configuration.fetchTimeoutMs > 10_000
    ) {
      throw new Error("invalid Google identity verifier configuration");
    }
    this.#configuration = configuration;
    this.#ports = ports;
  }

  async verify(token: string, audience: string): Promise<VerifiedGoogleIdentity> {
    try {
      if (
        token.length === 0 ||
        new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES ||
        token.split(".").length !== 3 ||
        audience.length === 0 ||
        audience.length > 2048
      ) {
        throw new Error("invalid Google identity token syntax");
      }
      const header = protectedHeaderSchema.parse(decodeProtectedHeader(token));
      const key = await this.#getKey(header.kid);
      const now = this.#ports.clock.now();
      const verified = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        audience,
        clockTolerance: this.#configuration.clockSkewMs / 1000,
        currentDate: now,
        issuer: this.#configuration.issuer,
        requiredClaims: ["aud", "azp", "email", "email_verified", "exp", "iat", "iss", "sub"],
      });
      const claims = googleIdentityClaimsSchema.parse(verified.payload);
      if (
        claims.aud !== audience ||
        claims.azp !== claims.sub ||
        claims.exp <= claims.iat ||
        (claims.exp - claims.iat) * 1000 > MAX_TOKEN_LIFETIME_MS ||
        claims.iat * 1000 > now.getTime() + this.#configuration.clockSkewMs ||
        claims.exp * 1000 <= now.getTime()
      ) {
        throw new Error("invalid Google identity token claims");
      }
      return {
        audience: claims.aud,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        issuer: claims.iss,
        serviceAccountEmail: claims.email,
        subjectId: claims.sub,
      };
    } catch {
      throw new Error("Google identity token was rejected");
    }
  }

  async #getKey(keyId: string): Promise<JWK> {
    const now = this.#ports.clock.now().getTime();
    let cache = this.#cache;
    if (cache === null || cache.expiresAtMs <= now) cache = await this.#refreshKeys();
    let key = cache.keys.find((candidate) => candidate.kid === keyId);
    if (key !== undefined) return key;
    if (now - cache.fetchedAtMs < UNKNOWN_KEY_REFRESH_COOLDOWN_MS) {
      throw new Error("Google identity key was rejected");
    }
    cache = await this.#refreshKeys();
    key = cache.keys.find((candidate) => candidate.kid === keyId);
    if (key === undefined) throw new Error("Google identity key was rejected");
    return key;
  }

  async #refreshKeys(): Promise<CachedGoogleJwks> {
    if (this.#refresh !== null) return this.#refresh;
    this.#refresh = this.#fetchKeys();
    try {
      const cache = await this.#refresh;
      this.#cache = cache;
      return cache;
    } finally {
      this.#refresh = null;
    }
  }

  async #fetchKeys(): Promise<CachedGoogleJwks> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#configuration.fetchTimeoutMs);
    let response: Response;
    try {
      response = await this.#ports.fetch(GOOGLE_OAUTH_JWKS_URL, {
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status !== 200) throw new Error("Google JWKS response was rejected");
    const cacheLifetimeMs = parseMaxAge(response.headers.get("cache-control"));
    const parsed = googleJwksSchema.parse(await readBoundedJson(response));
    const fetchedAtMs = this.#ports.clock.now().getTime();
    return {
      expiresAtMs: fetchedAtMs + cacheLifetimeMs,
      fetchedAtMs,
      keys: parsed.keys,
    };
  }
}
