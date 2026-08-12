import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { GOOGLE_OAUTH_JWKS_URL, GoogleOidcIdentityVerifier } from "./google-identity-verifier.js";

const AUDIENCE = "https://orchestrator.example.invalid/internal/cloud-run/bootstrap";
const EMAIL = "runtime@scribe-phase14.iam.gserviceaccount.com";
const ISSUER = "https://accounts.google.com" as const;
const SUBJECT = "112010400000000710080";
const FIRST_KID = "1".repeat(40);
const SECOND_KID = "2".repeat(40);
const NOW_SECONDS = Date.parse("2026-08-11T00:00:00.000Z") / 1000;

interface SigningKey {
  readonly jwk: JWK;
  readonly key: CryptoKey;
  readonly kid: string;
}

class MutableClock {
  value = new Date(NOW_SECONDS * 1000);

  now(): Date {
    return new Date(this.value);
  }
}

let first: SigningKey;
let second: SigningKey;

async function createSigningKey(kid: string): Promise<SigningKey> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  return {
    jwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      kid,
      kty: "RSA",
      use: "sig",
    },
    key: pair.privateKey,
    kid,
  };
}

beforeAll(async () => {
  [first, second] = await Promise.all([createSigningKey(FIRST_KID), createSigningKey(SECOND_KID)]);
});

async function token(
  signingKey: SigningKey,
  overrides: {
    readonly audience?: string;
    readonly authorizedParty?: string;
    readonly emailVerified?: boolean;
    readonly expiresAt?: number;
    readonly headerKeyId?: string;
    readonly issuedAt?: number;
    readonly issuer?: string;
    readonly subject?: string;
  } = {},
): Promise<string> {
  const issuedAt = overrides.issuedAt ?? NOW_SECONDS;
  return new SignJWT({
    azp: overrides.authorizedParty ?? SUBJECT,
    email: EMAIL,
    email_verified: overrides.emailVerified ?? true,
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: overrides.headerKeyId ?? signingKey.kid,
      typ: "JWT",
    })
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(overrides.expiresAt ?? issuedAt + 3600)
    .setIssuedAt(issuedAt)
    .setIssuer(overrides.issuer ?? ISSUER)
    .setSubject(overrides.subject ?? SUBJECT)
    .sign(signingKey.key);
}

function jwksResponse(keys: readonly JWK[], cacheControl = "public, max-age=3600"): Response {
  return new Response(JSON.stringify({ keys }), {
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}

function verifier(
  providerFetch: typeof fetch,
  clock = new MutableClock(),
): GoogleOidcIdentityVerifier {
  return new GoogleOidcIdentityVerifier(
    { clockSkewMs: 30_000, fetchTimeoutMs: 5_000, issuer: ISSUER },
    { clock, fetch: providerFetch },
  );
}

describe("GoogleOidcIdentityVerifier", () => {
  it("verifies an exact service-account token and reuses bounded JWKS cache", async () => {
    let requests = 0;
    const providerFetch: typeof fetch = (input, init) => {
      requests += 1;
      expect(input).toBe(GOOGLE_OAUTH_JWKS_URL);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return Promise.resolve(jwksResponse([first.jwk]));
    };
    const identity = verifier(providerFetch);
    const signed = await token(first);
    await expect(identity.verify(signed, AUDIENCE)).resolves.toEqual({
      audience: AUDIENCE,
      expiresAt: "2026-08-11T01:00:00.000Z",
      issuedAt: "2026-08-11T00:00:00.000Z",
      issuer: ISSUER,
      serviceAccountEmail: EMAIL,
      subjectId: SUBJECT,
    });
    await expect(identity.verify(signed, AUDIENCE)).resolves.toBeDefined();
    expect(requests).toBe(1);
  });

  it("rejects forged, stale, wrong-bound, and non-service-account claims", async () => {
    const identity = verifier(() => Promise.resolve(jwksResponse([first.jwk])));
    const invalid = await Promise.all([
      token(second, { headerKeyId: FIRST_KID }),
      token(first, { audience: "https://wrong.example.invalid/" }),
      token(first, { issuer: "accounts.google.com" }),
      token(first, { expiresAt: NOW_SECONDS }),
      token(first, { emailVerified: false }),
      token(first, { authorizedParty: "112010400000000710081" }),
    ]);
    for (const candidate of invalid) {
      await expect(identity.verify(candidate, AUDIENCE)).rejects.toThrow(
        "Google identity token was rejected",
      );
    }
  });

  it("refreshes once for a rotated key after cooldown and suppresses random-key fetches", async () => {
    const clock = new MutableClock();
    let requests = 0;
    const identity = verifier(() => {
      requests += 1;
      return Promise.resolve(jwksResponse(requests === 1 ? [first.jwk] : [second.jwk]));
    }, clock);
    await expect(identity.verify(await token(first), AUDIENCE)).resolves.toBeDefined();
    clock.value = new Date(clock.value.getTime() + 31_000);
    await expect(
      identity.verify(await token(second, { issuedAt: NOW_SECONDS + 31 }), AUDIENCE),
    ).resolves.toBeDefined();
    const unknown = await createSigningKey("3".repeat(40));
    await expect(
      identity.verify(await token(unknown, { issuedAt: NOW_SECONDS + 31 }), AUDIENCE),
    ).rejects.toThrow("Google identity token was rejected");
    expect(requests).toBe(2);
  });

  it("coalesces concurrent JWKS cache misses", async () => {
    let requests = 0;
    const identity = verifier(() => {
      requests += 1;
      return Promise.resolve(jwksResponse([first.jwk]));
    });
    const signed = await token(first);
    await expect(
      Promise.all([identity.verify(signed, AUDIENCE), identity.verify(signed, AUDIENCE)]),
    ).resolves.toHaveLength(2);
    expect(requests).toBe(1);
  });

  it("rejects redirect, oversized, and cache-policy drift without exposing responses", async () => {
    const signed = await token(first);
    const responses = [
      new Response(null, { status: 302 }),
      new Response("{}", {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-length": "65537",
          "content-type": "application/json",
        },
      }),
      jwksResponse([first.jwk], "no-store"),
    ];
    for (const response of responses) {
      await expect(
        verifier(() => Promise.resolve(response)).verify(signed, AUDIENCE),
      ).rejects.toThrow("Google identity token was rejected");
    }
  });
});
