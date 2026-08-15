import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStagingReleaseInputs,
  verifyStagingReleaseInputs,
} from "./staging-release-inputs.mjs";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION: "3",
  SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN:
    "https://scribe-drop-staging-gpu-controller-601035271372.asia-southeast1.run.app",
  SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT:
    "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
  SCRIBE_DROP_STAGING_R2_HOST: `${"a".repeat(32)}.r2.cloudflarestorage.com`,
};

const observed = {
  primarySecretVersion: {
    name: "projects/601035271372/secrets/scribe-drop-staging-controller-primary/versions/3",
    state: "ENABLED",
  },
  runtimeServiceAccount: {
    disabled: false,
    email: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    name: "projects/scribe-drop/serviceAccounts/gpu-runtime@scribe-drop.iam.gserviceaccount.com",
  },
  service: {
    name: "projects/scribe-drop/locations/asia-southeast1/services/scribe-drop-staging-gpu-controller",
    urls: [
      "https://scribe-drop-staging-gpu-controller-hash.asia-southeast1.run.app",
      environment.SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN,
    ],
  },
};

test("accepts the four exact source-controlled staging release inputs", () => {
  assert.deepEqual(parseStagingReleaseInputs(environment), {
    accountId: "a".repeat(32),
    controllerOrigin: environment.SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN,
    primarySecretVersion: "3",
    r2Host: environment.SCRIBE_DROP_STAGING_R2_HOST,
    runtimeServiceAccount: environment.SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT,
  });
  assert.deepEqual(verifyStagingReleaseInputs(environment, observed), {
    controllerOrigin: "verified",
    primarySecretVersion: "enabled",
    r2Host: "verified",
    runtimeServiceAccount: "verified",
  });
});

test("rejects each missing input before a remote mutation", () => {
  for (const name of [
    "SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION",
    "SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN",
    "SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
    "SCRIBE_DROP_STAGING_R2_HOST",
  ]) {
    assert.throws(
      () => parseStagingReleaseInputs({ ...environment, [name]: undefined }),
      /missing/u,
    );
  }
});

test("rejects a hash origin, cross-account R2 host, disabled identity, and secret drift", () => {
  assert.throws(
    () =>
      parseStagingReleaseInputs({
        ...environment,
        SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN:
          "https://scribe-drop-staging-gpu-controller-hash.asia-southeast1.run.app",
      }),
    /numeric Cloud Run origin/u,
  );
  assert.throws(
    () =>
      parseStagingReleaseInputs({
        ...environment,
        SCRIBE_DROP_STAGING_R2_HOST: `${"b".repeat(32)}.r2.cloudflarestorage.com`,
      }),
    /isolated Cloudflare account/u,
  );
  assert.throws(
    () =>
      verifyStagingReleaseInputs(environment, {
        ...observed,
        runtimeServiceAccount: { ...observed.runtimeServiceAccount, disabled: true },
      }),
    /service account read-back/u,
  );
  assert.throws(
    () =>
      verifyStagingReleaseInputs(environment, {
        ...observed,
        primarySecretVersion: { ...observed.primarySecretVersion, state: "DISABLED" },
      }),
    /secret version read-back/u,
  );
});
