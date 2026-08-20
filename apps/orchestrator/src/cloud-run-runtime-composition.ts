import { createUlid } from "@scribe-drop/domain";
import { createStructuredLogger } from "@scribe-drop/observability";

import { CloudRunControllerClient } from "./cloud-run-controller-client.js";
import { R2RuntimeCapabilityIssuer } from "./cloud-run-runtime-capabilities.js";
import { D1CloudRunRuntimeStore } from "./cloud-run-runtime-d1-store.js";
import { CloudRunTerminalFinalizer } from "./cloud-run-terminal-finalizer.js";
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
import type { CloudRunRuntimeHttpService } from "./cloud-run-runtime-http.js";
import {
  createD1RuntimeFaultTargetRepository,
  createStagingAcceptanceRuntimeService,
} from "./cloud-run-runtime-fault-service.js";
import { parseStagingAcceptanceFault } from "./staging-acceptance-fault.js";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_MS = 30_000;
const CONTROLLER_REQUEST_LIFETIME_MS = 30_000;
const GOOGLE_JWKS_TIMEOUT_MS = 5_000;
const SESSION_LIFETIME_MS = 55 * 60 * 1_000;

export interface CloudRunRuntimeCompositionEnvironment extends CloudRunRuntimeServiceConfigEnvironment {
  readonly RECORDINGS: R2Bucket;
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
): CloudRunRuntimeHttpService | undefined {
  const acceptanceFault = parseStagingAcceptanceFault(environment);
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) return undefined;

  const clock: RuntimeClock = { now: () => new Date() };
  const logger = createStructuredLogger({
    environment: config.appEnvironment,
    now: () => clock.now(),
    service: "orchestrator",
    sink: (record) => {
      console.warn(record);
    },
  });
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

  const service = new CloudRunRuntimeService(
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
        {
          clock,
          fetch,
          onRejected: (errorCode) => {
            logger.warn("cloud_run_identity_rejected", { errorCode });
          },
        },
      ),
      finalizer: new CloudRunTerminalFinalizer(environment.SCRIBE_DROP_DB, environment.RECORDINGS, {
        createEventId: () => ids.next(),
        createNotificationId: () => ids.next(),
        now: () => clock.now(),
      }),
      secrets: new HmacRuntimeSecretDeriver(requireSecret(config.runtimeDerivationSecret)),
      signatures: new WebCryptoEd25519Verifier(),
      store: new D1CloudRunRuntimeStore(environment.SCRIBE_DROP_DB, config.appEnvironment),
    },
  );
  return createStagingAcceptanceRuntimeService(
    service,
    acceptanceFault,
    createD1RuntimeFaultTargetRepository(environment.SCRIBE_DROP_DB),
    clock,
  );
}
