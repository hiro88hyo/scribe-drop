const exactRoleIds = [
  "backend-control-plane",
  "pages-ci",
  "r2-parent-signer",
  "staging-access-service-principal",
];

const exactApiTokenPermissions = {
  "backend-control-plane": [
    "Access: Apps and Policies Edit",
    "Access: Service Tokens Edit",
    "D1 Edit",
    "Queues Edit",
    "Workers R2 Storage Edit",
    "Workers Scripts Edit",
  ],
  "pages-ci": ["Cloudflare Pages Edit"],
};

const forbiddenPermissionFragments = [
  "Account Analytics",
  "Account Settings",
  "API Tokens",
  "DNS",
  "Logs",
  "Workers Routes",
  "Workers Tail",
  "Zero Trust",
];

const allowedWorkflowWranglerCommandPrefixes = [
  "pnpm exec wrangler d1 migrations apply ",
  "pnpm exec wrangler deploy ",
  "pnpm exec wrangler pages deploy ",
  "pnpm exec wrangler pages deployment list ",
  "pnpm exec wrangler r2 bucket cors set ",
  "pnpm exec wrangler r2 bucket lifecycle set ",
];

const exactCloudflareApiFiles = [
  "scripts/cloudflare-readback.mjs",
  "scripts/pages-promotion.mjs",
  "scripts/pages-upload-permission.mjs",
  "scripts/staging-access-control-plane.mjs",
];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireExactStrings(value, expected, name) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    throw new Error(`${name} does not match the reviewed least-privilege policy`);
  }
}

export function verifyCloudflareCredentialPolicy(policy, evidence) {
  const root = requireRecord(policy, "Cloudflare credential policy");
  if (root.schemaVersion !== 1 || root.accountScope !== "exact-account") {
    throw new Error("Cloudflare credential policy scope is invalid");
  }
  if (!Array.isArray(root.roles)) {
    throw new Error("Cloudflare credential policy roles are invalid");
  }
  requireExactStrings(
    root.roles.map((role) => requireRecord(role, "Cloudflare credential role").id),
    exactRoleIds,
    "Cloudflare credential role IDs",
  );

  const roles = new Map(root.roles.map((role) => [role.id, role]));
  for (const [roleId, permissions] of Object.entries(exactApiTokenPermissions)) {
    const role = requireRecord(roles.get(roleId), `Cloudflare credential role ${roleId}`);
    if (role.credentialType !== "cloudflare-api-token") {
      throw new Error(`${roleId} must remain a Cloudflare API token`);
    }
    requireExactStrings(role.accountPermissions, permissions, `${roleId} account permissions`);
    requireExactStrings(role.zonePermissions, [], `${roleId} zone permissions`);
    for (const permission of role.accountPermissions) {
      if (forbiddenPermissionFragments.some((fragment) => permission.includes(fragment))) {
        throw new Error(`${roleId} includes an unreviewed broad permission`);
      }
    }
  }

  const backendRole = requireRecord(
    roles.get("backend-control-plane"),
    "backend-control-plane role",
  );
  requireExactStrings(
    backendRole.placement,
    [
      "github-environment:staging",
      "github-environment:production",
      "local-credential-store:temporary",
    ],
    "backend-control-plane placement",
  );
  if (backendRole.credentialName !== "CLOUDFLARE_API_TOKEN") {
    throw new Error("backend-control-plane credential name is invalid");
  }

  const pagesRole = requireRecord(roles.get("pages-ci"), "pages-ci role");
  requireExactStrings(
    pagesRole.placement,
    ["github-environment:staging", "github-environment:production"],
    "pages-ci placement",
  );
  if (pagesRole.credentialName !== "CLOUDFLARE_PAGES_API_TOKEN") {
    throw new Error("pages-ci credential name is invalid");
  }

  const r2Role = requireRecord(roles.get("r2-parent-signer"), "r2-parent-signer role");
  if (
    r2Role.credentialType !== "r2-s3-api-token" ||
    r2Role.resourceScope !== "exact-environment-bucket"
  ) {
    throw new Error("R2 parent signer scope is invalid");
  }
  requireExactStrings(
    r2Role.dashboardPermissions,
    ["Object Read & Write"],
    "R2 parent signer permissions",
  );

  const serviceRole = requireRecord(
    roles.get("staging-access-service-principal"),
    "staging-access-service-principal role",
  );
  if (
    serviceRole.credentialType !== "cloudflare-access-service-token" ||
    serviceRole.productionAllowed !== false
  ) {
    throw new Error("Staging Access service principal scope is invalid");
  }
  requireExactStrings(
    serviceRole.placement,
    ["github-environment:staging"],
    "Staging Access service principal placement",
  );

  const documentation = typeof evidence?.documentation === "string" ? evidence.documentation : "";
  for (const marker of [
    "Access: Apps and Policies Edit",
    "Access: Service Tokens Edit",
    "D1 Edit",
    "Queues Edit",
    "Workers R2 Storage Edit",
    "Workers Scripts Edit",
    "Cloudflare Pages Edit",
    "Object Read & Write",
  ]) {
    if (!documentation.includes(marker)) {
      throw new Error(`Cloudflare permission documentation is missing ${marker}`);
    }
  }

  const workflows = typeof evidence?.workflows === "string" ? evidence.workflows : "";
  if (
    !workflows.includes("secrets.CLOUDFLARE_API_TOKEN") ||
    !workflows.includes("secrets.CLOUDFLARE_PAGES_API_TOKEN")
  ) {
    throw new Error("Cloudflare CI token roles are missing from the reviewed workflows");
  }
  const wranglerCommands = workflows
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("pnpm exec wrangler "));
  if (wranglerCommands.length === 0) {
    throw new Error("Cloudflare workflow command inventory is empty");
  }
  for (const command of wranglerCommands) {
    if (!allowedWorkflowWranglerCommandPrefixes.some((prefix) => command.startsWith(prefix))) {
      throw new Error(`Unreviewed Cloudflare workflow command: ${command}`);
    }
  }
  requireExactStrings(
    evidence?.cloudflareApiFiles,
    exactCloudflareApiFiles,
    "Cloudflare direct API source files",
  );
  return {
    apiTokenRoles: Object.keys(exactApiTokenPermissions).length,
    cloudflareApiFiles: exactCloudflareApiFiles.length,
    credentialRoles: root.roles.length,
    wranglerCommands: wranglerCommands.length,
  };
}
