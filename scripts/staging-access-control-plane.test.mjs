import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyStagingAccessControlPlane } from "./staging-access-control-plane.mjs";

const expected = {
  customAudience: "custom-audience",
  pagesAudience: "pages-audience",
  serviceTokenCommonName: "0123456789abcdef0123456789abcdef.access",
};
const serviceToken = {
  client_id: expected.serviceTokenCommonName,
  id: "service-token-id",
};

function exactPolicy() {
  return {
    decision: "non_identity",
    exclude: [],
    include: [{ service_token: { token_id: serviceToken.id } }],
    require: [],
  };
}

function inventory() {
  return {
    applications: [
      {
        aud: expected.customAudience,
        id: "custom-application",
        policies: [{ decision: "allow" }, exactPolicy()],
        type: "self_hosted",
      },
      {
        aud: expected.pagesAudience,
        id: "pages-application",
        policies: [{ decision: "allow" }, exactPolicy()],
        read_service_tokens_from_header: "Authorization",
        type: "self_hosted",
      },
    ],
    serviceTokens: [serviceToken],
  };
}

test("accepts two distinct Access applications with exact layer-specific Service Auth", () => {
  assert.deepEqual(verifyStagingAccessControlPlane(inventory(), expected), {
    applications: 2,
    serviceAuthPolicies: 2,
  });
});

test("rejects a missing Pages Authorization header configuration", () => {
  const candidate = inventory();
  delete candidate.applications[1].read_service_tokens_from_header;
  assert.throws(
    () => verifyStagingAccessControlPlane(candidate, expected),
    /Pages Access service-token header/u,
  );
});

test("rejects broad or additional Service Auth policies", () => {
  const candidate = inventory();
  candidate.applications[1].policies.push({
    decision: "non_identity",
    include: [{ any_valid_service_token: {} }],
  });
  assert.throws(
    () => verifyStagingAccessControlPlane(candidate, expected),
    /Pages Access Service Auth policy is not exact/u,
  );
});

test("rejects duplicate audiences and ambiguous service tokens", () => {
  assert.throws(
    () =>
      verifyStagingAccessControlPlane(inventory(), {
        ...expected,
        pagesAudience: expected.customAudience,
      }),
    /must be distinct/u,
  );
  const candidate = inventory();
  candidate.serviceTokens.push({ ...serviceToken, id: "duplicate-token" });
  assert.throws(
    () => verifyStagingAccessControlPlane(candidate, expected),
    /service token is missing or ambiguous/u,
  );
});
