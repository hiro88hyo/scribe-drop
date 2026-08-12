import { z } from "zod";

const timestampSchema = z.iso.datetime({ offset: true });
const etagSchema = z.string().min(1).max(1024);
const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u);
const projectNumberSchema = z.string().regex(/^[1-9][0-9]{5,19}$/u);
const serviceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u);
const secretNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,254}$/u);
const secretVersionSchema = z.string().regex(/^[1-9][0-9]*$/u);
const roleSchema = z
  .string()
  .regex(/^(?:roles\/[A-Za-z0-9_.]+|projects\/[a-z][a-z0-9-]{4,28}\/roles\/[A-Za-z0-9_.]+)$/u);

const iamConditionSchema = z
  .object({
    description: z.string().max(4096).optional(),
    expression: z.string().min(1).max(4096),
    location: z.string().max(4096).optional(),
    title: z.string().min(1).max(256),
  })
  .strict();

export const iamBindingReadbackSchema = z
  .object({
    condition: iamConditionSchema.optional(),
    members: z.array(z.string().min(1).max(1024)).min(1),
    role: roleSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (new Set(binding.members).size !== binding.members.length) {
      context.addIssue({ code: "custom", message: "IAM binding contains duplicate members" });
    }
  });

const auditLogConfigSchema = z
  .object({
    exemptedMembers: z.array(z.string().min(1).max(1024)).optional(),
    logType: z.enum(["LOG_TYPE_UNSPECIFIED", "ADMIN_READ", "DATA_WRITE", "DATA_READ"]),
  })
  .strict();

const auditConfigSchema = z
  .object({
    auditLogConfigs: z.array(auditLogConfigSchema),
    service: z.string().min(1).max(256),
  })
  .strict();

export const iamPolicyReadbackSchema = z
  .object({
    auditConfigs: z.array(auditConfigSchema).optional(),
    bindings: z.array(iamBindingReadbackSchema).optional(),
    etag: etagSchema.optional(),
    version: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(),
  })
  .strict();

export type IamBindingReadback = z.infer<typeof iamBindingReadbackSchema>;

const iamCustomRoleFields = {
  description: z.string().min(1).max(4096),
  includedPermissions: z.array(z.string().regex(/^[a-z][a-zA-Z0-9.]+$/u)).min(1),
  name: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}\/roles\/[A-Za-z0-9_.]{3,64}$/u),
  stage: z.enum(["ALPHA", "BETA", "GA", "DEPRECATED", "DISABLED", "EAP"]),
  title: z.string().min(1).max(100),
} as const;

export const iamCustomRoleExpectationSchema = z
  .object({ ...iamCustomRoleFields, deleted: z.literal(false) })
  .strict()
  .superRefine((role, context) => {
    if (new Set(role.includedPermissions).size !== role.includedPermissions.length) {
      context.addIssue({ code: "custom", message: "custom IAM role permissions must be unique" });
    }
  });

export const iamCustomRoleReadbackSchema = z
  .object({ ...iamCustomRoleFields, deleted: z.literal(false).optional(), etag: etagSchema })
  .strict()
  .superRefine((role, context) => {
    if (new Set(role.includedPermissions).size !== role.includedPermissions.length) {
      context.addIssue({ code: "custom", message: "custom IAM role permissions must be unique" });
    }
  });

export type IamCustomRoleExpectation = z.infer<typeof iamCustomRoleExpectationSchema>;

export interface IamPolicyReadbackEvidence {
  readonly etag: string | undefined;
  readonly version: 0 | 1 | 3;
}

export interface IamCustomRoleReadbackEvidence {
  readonly etag: string;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeBindings(bindings: readonly IamBindingReadback[]): readonly unknown[] {
  return bindings
    .map((binding) => ({
      ...binding,
      members: [...binding.members].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}

export function verifyIamPolicyBindingsReadback(
  expectedBindings: readonly IamBindingReadback[],
  rawReadback: unknown,
): IamPolicyReadbackEvidence {
  const expected = z.array(iamBindingReadbackSchema).parse(expectedBindings);
  const observed = iamPolicyReadbackSchema.parse(rawReadback);
  const observedBindings = observed.bindings ?? [];
  const publicMembers = observedBindings.flatMap(({ members }) =>
    members.filter((member) => member === "allUsers" || member === "allAuthenticatedUsers"),
  );
  if (publicMembers.length !== 0) {
    throw new Error("IAM read-back contains a public principal");
  }
  if ((observed.auditConfigs ?? []).length !== 0) {
    throw new Error("resource IAM read-back contains unexpected audit configuration");
  }
  if (
    canonicalize(normalizeBindings(expected)) !== canonicalize(normalizeBindings(observedBindings))
  ) {
    throw new Error("IAM bindings do not match the expected least-authority policy");
  }
  return { etag: observed.etag, version: observed.version ?? 0 };
}

export function verifyControllerServiceIamReadback(
  rawReadback: unknown,
): IamPolicyReadbackEvidence {
  return verifyIamPolicyBindingsReadback([], rawReadback);
}

export function verifyIamPrincipalBindingsReadback(
  principal: string,
  expectedBindings: readonly IamBindingReadback[],
  rawReadback: unknown,
): IamPolicyReadbackEvidence {
  const expectedPrincipal = z
    .string()
    .regex(/^serviceAccount:[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u)
    .parse(principal);
  const expected = z.array(iamBindingReadbackSchema).parse(expectedBindings);
  if (
    expected.some(
      (binding) => binding.members.length !== 1 || binding.members[0] !== expectedPrincipal,
    )
  ) {
    throw new Error("expected IAM bindings must isolate the controller principal");
  }
  const observed = iamPolicyReadbackSchema.parse(rawReadback);
  const observedBindings = observed.bindings ?? [];
  if (
    observedBindings.some(({ members }) =>
      members.some((member) => member === "allUsers" || member === "allAuthenticatedUsers"),
    )
  ) {
    throw new Error("IAM read-back contains a public principal");
  }
  const principalBindings = observedBindings.filter(({ members }) =>
    members.includes(expectedPrincipal),
  );
  if (principalBindings.some(({ members }) => members.length !== 1)) {
    throw new Error("controller principal must not share an IAM binding with another principal");
  }
  if (
    canonicalize(normalizeBindings(expected)) !== canonicalize(normalizeBindings(principalBindings))
  ) {
    throw new Error("controller principal IAM bindings exceed the expected policy");
  }
  return { etag: observed.etag, version: observed.version ?? 0 };
}

export function verifyIamCustomRoleReadback(
  expectation: IamCustomRoleExpectation,
  rawReadback: unknown,
): IamCustomRoleReadbackEvidence {
  const expected = iamCustomRoleExpectationSchema.parse(expectation);
  const observed = iamCustomRoleReadbackSchema.parse(rawReadback);
  const normalizedExpected = {
    ...expected,
    includedPermissions: [...expected.includedPermissions].sort(),
  };
  const normalizedObserved = {
    deleted: observed.deleted ?? false,
    description: observed.description,
    includedPermissions: [...observed.includedPermissions].sort(),
    name: observed.name,
    stage: observed.stage,
    title: observed.title,
  };
  if (canonicalize(normalizedExpected) !== canonicalize(normalizedObserved)) {
    throw new Error("custom IAM role read-back does not match the permission manifest");
  }
  return { etag: observed.etag };
}

const secretReplicaSchema = z
  .object({
    customerManagedEncryption: z.never().optional(),
    location: z.literal("asia-southeast1"),
  })
  .strict();

export const secretManagerSecretReadbackSchema = z
  .object({
    annotations: z.record(z.string(), z.string()).optional(),
    createTime: timestampSchema,
    etag: etagSchema,
    expireTime: z.never().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).max(512),
    replication: z
      .object({
        automatic: z.never().optional(),
        userManaged: z.object({ replicas: z.tuple([secretReplicaSchema]) }).strict(),
      })
      .strict(),
    rotation: z.never().optional(),
    topics: z.array(z.never()).optional(),
    ttl: z.never().optional(),
    versionAliases: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const secretReplicaStatusSchema = z
  .object({
    customerManagedEncryption: z.never().optional(),
    location: z.literal("asia-southeast1"),
  })
  .strict();

export const secretManagerVersionReadbackSchema = z
  .object({
    clientSpecifiedPayloadChecksum: z.literal(true),
    createTime: timestampSchema,
    destroyTime: z.never().optional(),
    etag: etagSchema,
    name: z.string().min(1).max(768),
    replicationStatus: z
      .object({
        automatic: z.never().optional(),
        userManaged: z.object({ replicas: z.tuple([secretReplicaStatusSchema]) }).strict(),
      })
      .strict(),
    state: z.literal("ENABLED"),
  })
  .strict();

export const controllerSecretReadbackExpectationSchema = z
  .object({
    controllerServiceAccount: serviceAccountSchema,
    environment: z.enum(["staging", "production"]),
    name: secretNameSchema,
    projectId: projectIdSchema,
    projectNumber: projectNumberSchema,
    version: secretVersionSchema,
  })
  .strict()
  .superRefine((expectation, context) => {
    if (
      !expectation.controllerServiceAccount.endsWith(
        `@${expectation.projectId}.iam.gserviceaccount.com`,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "secret accessor must belong to the expected project",
      });
    }
    if (!new RegExp(`(?:^|[-_])${expectation.environment}(?:[-_]|$)`, "u").test(expectation.name)) {
      context.addIssue({ code: "custom", message: "secret name must include its environment" });
    }
  });

export type ControllerSecretReadbackExpectation = z.infer<
  typeof controllerSecretReadbackExpectationSchema
>;

export interface ControllerSecretReadbackEvidence {
  readonly secretCreateTime: string;
  readonly secretEtag: string;
  readonly secretIam: IamPolicyReadbackEvidence;
  readonly versionCreateTime: string;
  readonly versionEtag: string;
}

export function verifyControllerSecretReadback(
  expectation: ControllerSecretReadbackExpectation,
  rawSecret: unknown,
  rawVersion: unknown,
  rawIamPolicy: unknown,
): ControllerSecretReadbackEvidence {
  const expected = controllerSecretReadbackExpectationSchema.parse(expectation);
  const secret = secretManagerSecretReadbackSchema.parse(rawSecret);
  const version = secretManagerVersionReadbackSchema.parse(rawVersion);
  const secretResourceName = `projects/${expected.projectNumber}/secrets/${expected.name}`;
  if (secret.name !== secretResourceName) {
    throw new Error("Secret Manager secret resource name does not match");
  }
  if (version.name !== `${secretResourceName}/versions/${expected.version}`) {
    throw new Error("Secret Manager version resource name does not match the fixed version");
  }
  const expectedLabels = {
    "scribe-drop-component": "gpu-controller",
    "scribe-drop-environment": expected.environment,
  };
  if (canonicalize(secret.labels ?? {}) !== canonicalize(expectedLabels)) {
    throw new Error("Secret Manager labels do not match the environment boundary");
  }
  if (
    Object.keys(secret.annotations ?? {}).length !== 0 ||
    Object.keys(secret.versionAliases ?? {}).length !== 0
  ) {
    throw new Error("Secret Manager aliases and annotations are not allowed");
  }
  const secretIam = verifyIamPolicyBindingsReadback(
    [
      {
        members: [`serviceAccount:${expected.controllerServiceAccount}`],
        role: "roles/secretmanager.secretAccessor",
      },
    ],
    rawIamPolicy,
  );
  return {
    secretCreateTime: secret.createTime,
    secretEtag: secret.etag,
    secretIam,
    versionCreateTime: version.createTime,
    versionEtag: version.etag,
  };
}

const attestorNameSchema = z
  .string()
  .regex(/^projects\/[a-z][a-z0-9-]{4,28}\/attestors\/[A-Za-z0-9_-]{1,255}$/u);

const admissionRuleSchema = z
  .object({
    enforcementMode: z.enum([
      "ENFORCEMENT_MODE_UNSPECIFIED",
      "ENFORCED_BLOCK_AND_AUDIT_LOG",
      "DRYRUN_AUDIT_LOG_ONLY",
    ]),
    evaluationMode: z.enum([
      "EVALUATION_MODE_UNSPECIFIED",
      "ALWAYS_ALLOW",
      "REQUIRE_ATTESTATION",
      "ALWAYS_DENY",
    ]),
    requireAttestationsBy: z.array(attestorNameSchema).optional(),
  })
  .strict();

export const binaryAuthorizationPolicyReadbackSchema = z
  .object({
    admissionWhitelistPatterns: z
      .array(z.object({ namePattern: z.string().min(1).max(2048) }).strict())
      .optional(),
    clusterAdmissionRules: z.record(z.string(), admissionRuleSchema).optional(),
    defaultAdmissionRule: admissionRuleSchema,
    description: z.string().max(4096).optional(),
    etag: etagSchema,
    globalPolicyEvaluationMode: z.enum([
      "GLOBAL_POLICY_EVALUATION_MODE_UNSPECIFIED",
      "ENABLE",
      "DISABLE",
    ]),
    istioServiceIdentityAdmissionRules: z.record(z.string(), admissionRuleSchema).optional(),
    kubernetesNamespaceAdmissionRules: z.record(z.string(), admissionRuleSchema).optional(),
    kubernetesServiceAccountAdmissionRules: z.record(z.string(), admissionRuleSchema).optional(),
    name: z.string().min(1).max(512),
    updateTime: timestampSchema,
  })
  .strict();

export const binaryAuthorizationReadbackExpectationSchema = z
  .object({
    attestors: z.array(attestorNameSchema).min(1),
    projectId: projectIdSchema,
  })
  .strict()
  .superRefine((expectation, context) => {
    if (new Set(expectation.attestors).size !== expectation.attestors.length) {
      context.addIssue({
        code: "custom",
        message: "Binary Authorization attestors must be unique",
      });
    }
    if (
      expectation.attestors.some((name) => !name.startsWith(`projects/${expectation.projectId}/`))
    ) {
      context.addIssue({
        code: "custom",
        message: "Binary Authorization attestors must belong to the project",
      });
    }
  });

export type BinaryAuthorizationReadbackExpectation = z.infer<
  typeof binaryAuthorizationReadbackExpectationSchema
>;

export interface BinaryAuthorizationReadbackEvidence {
  readonly etag: string;
  readonly updateTime: string;
}

export function verifyBinaryAuthorizationPolicyReadback(
  expectation: BinaryAuthorizationReadbackExpectation,
  rawReadback: unknown,
): BinaryAuthorizationReadbackEvidence {
  const expected = binaryAuthorizationReadbackExpectationSchema.parse(expectation);
  const policy = binaryAuthorizationPolicyReadbackSchema.parse(rawReadback);
  if (policy.name !== `projects/${expected.projectId}/policy`) {
    throw new Error("Binary Authorization policy belongs to a different project");
  }
  if (policy.globalPolicyEvaluationMode !== "ENABLE") {
    throw new Error("Binary Authorization global policy evaluation must be enabled");
  }
  if (
    (policy.admissionWhitelistPatterns ?? []).length !== 0 ||
    Object.keys(policy.clusterAdmissionRules ?? {}).length !== 0 ||
    Object.keys(policy.kubernetesNamespaceAdmissionRules ?? {}).length !== 0 ||
    Object.keys(policy.kubernetesServiceAccountAdmissionRules ?? {}).length !== 0 ||
    Object.keys(policy.istioServiceIdentityAdmissionRules ?? {}).length !== 0
  ) {
    throw new Error("Binary Authorization policy contains an admission bypass or specialized rule");
  }
  const rule = policy.defaultAdmissionRule;
  if (
    rule.evaluationMode !== "REQUIRE_ATTESTATION" ||
    rule.enforcementMode !== "ENFORCED_BLOCK_AND_AUDIT_LOG" ||
    canonicalize([...(rule.requireAttestationsBy ?? [])].sort()) !==
      canonicalize([...expected.attestors].sort())
  ) {
    throw new Error("Binary Authorization default rule does not require the expected attestations");
  }
  return { etag: policy.etag, updateTime: policy.updateTime };
}
