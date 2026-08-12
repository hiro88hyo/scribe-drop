import { z } from "zod";

import {
  iamPolicyReadbackSchema,
  verifyIamPolicyBindingsReadback,
  type IamPolicyReadbackEvidence,
} from "./control-plane-readback.js";
import {
  releaseWorkloadIdentityPlanSchema,
  type ReleaseWorkloadIdentityPlan,
} from "./release-workload-identity.js";

const resourceNameSchema = z.string().min(1).max(1024);

export const releaseWorkloadIdentityPoolReadbackSchema = z
  .object({
    description: z.string().max(256),
    disabled: z.literal(false),
    displayName: z.string().max(32),
    expireTime: z.never().optional(),
    inlineCertificateIssuanceConfig: z.never().optional(),
    inlineTrustConfig: z.never().optional(),
    mode: z.literal("FEDERATION_ONLY"),
    name: resourceNameSchema,
    state: z.literal("ACTIVE"),
  })
  .strict();

export const releaseWorkloadIdentityProviderReadbackSchema = z
  .object({
    attributeCondition: z.string().min(1).max(4096),
    attributeMapping: z
      .object({
        "attribute.repository_id": z.string().min(1).max(2048),
        "attribute.repository_owner_id": z.string().min(1).max(2048),
        "google.subject": z.string().min(1).max(2048),
      })
      .strict(),
    description: z.string().max(256),
    disabled: z.literal(false),
    displayName: z.string().max(32),
    expireTime: z.never().optional(),
    name: resourceNameSchema,
    oidc: z
      .object({
        allowedAudiences: z.tuple([]).optional(),
        issuerUri: z.url(),
        jwksJson: z.never().optional(),
      })
      .strict(),
    state: z.literal("ACTIVE"),
  })
  .strict();

export const releaseServiceAccountReadbackSchema = z
  .object({
    description: z.string().max(256),
    disabled: z.literal(false),
    displayName: z.string().max(100),
    email: z.email(),
    etag: z.string().min(1).max(1024).optional(),
    name: resourceNameSchema,
    oauth2ClientId: z.string().regex(/^[1-9][0-9]{5,24}$/u),
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u),
    uniqueId: z.string().regex(/^[1-9][0-9]{5,24}$/u),
  })
  .strict();

export const noUserManagedServiceAccountKeysReadbackSchema = z
  .object({ keys: z.tuple([]).optional() })
  .strict();

const serviceAccountBoundaryReadbackSchema = z
  .object({
    account: releaseServiceAccountReadbackSchema,
    iamPolicy: iamPolicyReadbackSchema,
    userManagedKeys: noUserManagedServiceAccountKeysReadbackSchema,
  })
  .strict();

export const releaseWorkloadIdentityRawReadbackSchema = z
  .object({
    pool: releaseWorkloadIdentityPoolReadbackSchema,
    provider: releaseWorkloadIdentityProviderReadbackSchema,
    serviceAccounts: z.tuple([
      serviceAccountBoundaryReadbackSchema,
      serviceAccountBoundaryReadbackSchema,
    ]),
  })
  .strict();

export type ReleaseWorkloadIdentityRawReadback = z.input<
  typeof releaseWorkloadIdentityRawReadbackSchema
>;

export interface ReleaseWorkloadIdentityReadbackEvidence {
  readonly poolState: "ACTIVE";
  readonly providerState: "ACTIVE";
  readonly serviceAccounts: readonly [
    {
      readonly email: string;
      readonly iam: IamPolicyReadbackEvidence;
      readonly uniqueId: string;
      readonly userManagedKeyCount: 0;
    },
    {
      readonly email: string;
      readonly iam: IamPolicyReadbackEvidence;
      readonly uniqueId: string;
      readonly userManagedKeyCount: 0;
    },
  ];
}

function verifyServiceAccount(
  expected: ReleaseWorkloadIdentityPlan,
  index: 0 | 1,
  observed: z.infer<typeof serviceAccountBoundaryReadbackSchema>,
): ReleaseWorkloadIdentityReadbackEvidence["serviceAccounts"][0] {
  const account = expected.serviceAccounts[index];
  const permissions = index === 0 ? expected.permissions.publisher : expected.permissions.signer;
  if (
    observed.account.name !== account.name ||
    observed.account.projectId !== expected.projectId ||
    observed.account.email !== account.email ||
    observed.account.displayName !== account.displayName ||
    observed.account.description !== account.description
  ) {
    throw new Error("release service account read-back drifted");
  }
  return {
    email: observed.account.email,
    iam: verifyIamPolicyBindingsReadback(permissions.bindings, observed.iamPolicy),
    uniqueId: observed.account.uniqueId,
    userManagedKeyCount: 0,
  };
}

export function verifyReleaseWorkloadIdentityReadback(
  expectation: ReleaseWorkloadIdentityPlan,
  rawReadback: unknown,
): ReleaseWorkloadIdentityReadbackEvidence {
  const expected = releaseWorkloadIdentityPlanSchema.parse(expectation);
  const observed = releaseWorkloadIdentityRawReadbackSchema.parse(rawReadback);
  if (
    observed.pool.name !== expected.pool.name ||
    observed.pool.displayName !== expected.pool.displayName ||
    observed.pool.description !== expected.pool.description
  ) {
    throw new Error("release workload identity pool read-back drifted");
  }
  if (
    observed.provider.name !== expected.provider.name ||
    observed.provider.displayName !== expected.provider.displayName ||
    observed.provider.description !== expected.provider.description ||
    observed.provider.attributeCondition !== expected.provider.attributeCondition ||
    observed.provider.attributeMapping["google.subject"] !==
      expected.provider.attributeMapping["google.subject"] ||
    observed.provider.attributeMapping["attribute.repository_id"] !==
      expected.provider.attributeMapping["attribute.repository_id"] ||
    observed.provider.attributeMapping["attribute.repository_owner_id"] !==
      expected.provider.attributeMapping["attribute.repository_owner_id"] ||
    observed.provider.oidc.issuerUri !== expected.provider.oidc.issuerUri
  ) {
    throw new Error("release workload identity provider read-back drifted");
  }
  const publisher = verifyServiceAccount(expected, 0, observed.serviceAccounts[0]);
  const signer = verifyServiceAccount(expected, 1, observed.serviceAccounts[1]);
  if (publisher.uniqueId === signer.uniqueId) {
    throw new Error("publisher and signer service accounts must be distinct");
  }
  return {
    poolState: observed.pool.state,
    providerState: observed.provider.state,
    serviceAccounts: [publisher, signer],
  };
}
