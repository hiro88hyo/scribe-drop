import { createUlid } from "@scribe-drop/domain";

import { CloudRunControllerClient } from "./cloud-run-controller-client.js";
import { R2RuntimeCapabilityIssuer } from "./cloud-run-runtime-capabilities.js";
import { D1CloudRunRuntimeStore } from "./cloud-run-runtime-d1-store.js";
import {
  CloudRunRuntimeService,
  HmacRuntimeSecretDeriver,
  WebCryptoEd25519Verifier,
  type RuntimeClock,
  type RuntimeIdGenerator,
} from "./cloud-run-runtime-service.js";
import {
  decodeCloudRunRuntimeSecret,
  parseCloudRunRuntimeServiceConfig,
  type CloudRunRuntimeServiceConfigEnvironment,
} from "./config.js";
import { GoogleOidcIdentityVerifier } from "./google-identity-verifier.js";
import { createR2CapabilityIssuer } from "./r2-capability-issuer.js";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_MS = 30_000;
const CONTROLLER_REQUEST_LIFETIME_MS = 30_000;
const GOOGLE_JWKS_TIMEOUT_MS = 5_000;
const SESSION_LIFETIME_MS = 55 * 60 * 1_000;

export interface CloudRunRuntimeCompositionEnvironment extends CloudRunRuntimeServiceConfigEnvironment {
  readonly SCRIBE_DROP_DB: D1Database;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function requireSecret(value: string): Uint8Array {
  const decoded = decodeCloudRunRuntimeSecret(value);
  if (decoded === undefined) throw new Error("Cloud Run runtime secret is invalid");
  return decoded;
}

export function createCloudRunRuntimeService(
  environment: CloudRunRuntimeCompositionEnvironment,
): CloudRunRuntimeService | undefined {
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) return undefined;

  const clock: RuntimeClock = { now: () => new Date() };
  const ids: RuntimeIdGenerator = {
    next: () => createUlid(clock.now().getTime(), randomBytes),
  };
  const controller = new CloudRunControllerClient(
    {
      baseUrl: config.controllerOrigin,
      environment: config.appEnvironment,
      keyId: "primary",
      requestLifetimeMs: CONTROLLER_REQUEST_LIFETIME_MS,
      secret: requireSecret(config.controllerHmacPrimary),
    },
    { clock, fetch, ids },
  );
  const capabilities = new R2RuntimeCapabilityIssuer(
    config.r2BucketName,
    createR2CapabilityIssuer({
      accessKeyId: config.r2AccessKeyId,
      accountId: config.cloudflareAccountId,
      now: () => clock.now(),
      secretAccessKey: config.r2SecretAccessKey,
    }),
  );

  return new CloudRunRuntimeService(
    {
      challengeLifetimeMs: CHALLENGE_LIFETIME_MS,
      clockSkewMs: CLOCK_SKEW_MS,
      environment: config.appEnvironment,
      identityAudience: new URL(
        "internal/cloud-run/bootstrap",
        config.orchestratorOrigin,
      ).toString(),
      identityIssuer: "https://accounts.google.com",
      runtimeServiceAccount: config.runtimeServiceAccount,
      sessionLifetimeMs: SESSION_LIFETIME_MS,
    },
    {
      attestor: controller,
      capabilities,
      cleanup: controller,
      clock,
      ids,
      identity: new GoogleOidcIdentityVerifier(
        {
          clockSkewMs: CLOCK_SKEW_MS,
          fetchTimeoutMs: GOOGLE_JWKS_TIMEOUT_MS,
          issuer: "https://accounts.google.com",
        },
        { clock, fetch },
      ),
      secrets: new HmacRuntimeSecretDeriver(requireSecret(config.runtimeDerivationSecret)),
      signatures: new WebCryptoEd25519Verifier(),
      store: new D1CloudRunRuntimeStore(environment.SCRIBE_DROP_DB, config.appEnvironment),
    },
  );
}
