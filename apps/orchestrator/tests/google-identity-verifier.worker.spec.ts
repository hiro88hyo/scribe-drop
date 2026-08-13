import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  GOOGLE_OAUTH_JWKS_URL,
  GoogleOidcIdentityVerifier,
} from "../src/google-identity-verifier.js";

const AUDIENCE = "https://orchestrator.example.invalid/internal/cloud-run/bootstrap";
const EMAIL = "gpu-runtime@scribe-drop.iam.gserviceaccount.com";
const ISSUER = "https://accounts.google.com" as const;
const KID = "1".repeat(40);
const SUBJECT = "112010400000000710080";
const NOW = new Date("2026-08-13T00:00:00.000Z");

describe("GoogleOidcIdentityVerifier in workerd", () => {
  it("imports and verifies a live-shaped Google RSA JWK", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      kid: KID,
      kty: "RSA",
      use: "sig",
    };
    const issuedAt = Math.floor(NOW.getTime() / 1000);
    const token = await new SignJWT({
      azp: SUBJECT,
      email: EMAIL,
      email_verified: true,
      google: {
        compute_engine: {
          instance_id: "1234567890123456789",
          project_id: "scribe-drop",
          project_number: 601035271372,
          zone: "projects/601035271372/zones/asia-southeast1-b",
        },
      },
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setAudience(AUDIENCE)
      .setExpirationTime(issuedAt + 3600)
      .setIssuedAt(issuedAt)
      .setIssuer(ISSUER)
      .setSubject(SUBJECT)
      .sign(pair.privateKey);
    let requests = 0;
    const verifier = new GoogleOidcIdentityVerifier(
      { clockSkewMs: 30_000, fetchTimeoutMs: 5_000, issuer: ISSUER },
      {
        clock: { now: () => new Date(NOW) },
        fetch: (input, init) => {
          requests += 1;
          expect(input).toBe(GOOGLE_OAUTH_JWKS_URL);
          expect(init?.redirect).toBe("error");
          return Promise.resolve(
            new Response(JSON.stringify({ keys: [jwk] }), {
              headers: {
                "cache-control": "public, max-age=3600, must-revalidate, no-transform",
                "content-type": "application/json; charset=UTF-8",
              },
            }),
          );
        },
      },
    );

    await expect(verifier.verify(token, AUDIENCE)).resolves.toEqual({
      audience: AUDIENCE,
      expiresAt: "2026-08-13T01:00:00.000Z",
      issuedAt: "2026-08-13T00:00:00.000Z",
      issuer: ISSUER,
      serviceAccountEmail: EMAIL,
      subjectId: SUBJECT,
    });
    expect(requests).toBe(1);
  });
});
