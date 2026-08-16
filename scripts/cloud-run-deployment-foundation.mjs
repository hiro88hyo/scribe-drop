const PROJECT_ID = "scribe-drop";
const PROJECT_NUMBER = "601035271372";
const GITHUB_OWNER = "hiro88hyo";
const GITHUB_OWNER_ID = "1670222";
const GITHUB_REPOSITORY = "hiro88hyo/scribe-drop";
const GITHUB_REPOSITORY_ID = "1312444559";
const POOL = `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/scribe-drop-release`;

export const deploymentRolePermissions = Object.freeze([
  "artifactregistry.repositories.get",
  "artifactregistry.repositories.getIamPolicy",
  "binaryauthorization.policy.get",
  "datastore.databases.get",
  "datastore.databases.getMetadata",
  "datastore.entities.create",
  "datastore.entities.delete",
  "datastore.entities.get",
  "datastore.entities.list",
  "datastore.entities.update",
  "datastore.indexes.get",
  "datastore.indexes.list",
  "iam.roles.get",
  "iam.serviceAccounts.get",
  "iam.serviceAccounts.getIamPolicy",
  "iam.workloadIdentityPoolProviders.get",
  "resourcemanager.projects.getIamPolicy",
  "run.executions.get",
  "run.executions.list",
  "run.jobs.get",
  "run.jobs.list",
  "run.operations.get",
  "run.services.create",
  "run.services.get",
  "run.services.getIamPolicy",
  "run.services.update",
  "secretmanager.locations.get",
  "secretmanager.secrets.get",
  "secretmanager.secrets.getIamPolicy",
  "secretmanager.versions.get",
]);

export const stagingBootstrapPreflightRolePermissions = Object.freeze([
  "cloudquotas.quotas.get",
  "logging.logEntries.list",
  "run.executions.get",
  "run.executions.list",
  "run.jobs.create",
  "run.jobs.delete",
  "run.jobs.get",
  "run.jobs.list",
  "run.jobs.run",
  "run.operations.get",
  "serviceusage.services.list",
]);

function githubCondition(environment, workflowPath) {
  const subject = `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/scribe-drop@${GITHUB_REPOSITORY_ID}:environment:${environment}`;
  const workflowRef = `${GITHUB_REPOSITORY}/${workflowPath}@refs/heads/release/`;
  return [
    `assertion.repository == '${GITHUB_REPOSITORY}'`,
    `assertion.repository_id == '${GITHUB_REPOSITORY_ID}'`,
    `assertion.repository_owner == '${GITHUB_OWNER}'`,
    `assertion.repository_owner_id == '${GITHUB_OWNER_ID}'`,
    `assertion.sub == '${subject}'`,
    `assertion.environment == '${environment}'`,
    "assertion.ref.startsWith('refs/heads/release/')",
    "assertion.ref_type == 'branch'",
    "assertion.event_name == 'workflow_dispatch'",
    `assertion.workflow_ref.startsWith('${workflowRef}')`,
  ].join(" && ");
}

function deploymentIdentity(environment, workflowPath) {
  const accountId = `sd-${environment}-deployer`;
  const accountEmail = `${accountId}@${PROJECT_ID}.iam.gserviceaccount.com`;
  const providerId = `github-${environment}-deployment`;
  const principal =
    `principalSet://iam.googleapis.com/${POOL}` +
    `/attribute.repository_id/${GITHUB_REPOSITORY_ID}`;
  return {
    account: {
      description: `Deploys the reviewed ScribeDrop ${environment} candidate.`,
      displayName: `ScribeDrop ${environment} deployer`,
      email: accountEmail,
      id: accountId,
      name: `projects/${PROJECT_ID}/serviceAccounts/${accountEmail}`,
    },
    environment,
    principal,
    provider: {
      attributeCondition: githubCondition(environment, workflowPath),
      attributeMapping: {
        "attribute.repository_id": "assertion.repository_id",
        "attribute.repository_owner_id": "assertion.repository_owner_id",
        "google.subject": "assertion.sub",
      },
      description: `Trusts only the exact ScribeDrop ${environment} deployment workflow claims.`,
      displayName: `ScribeDrop ${environment}`,
      id: providerId,
      name: `${POOL}/providers/${providerId}`,
      oidcIssuer: "https://token.actions.githubusercontent.com",
    },
    workflowPath,
  };
}

export function createStandardFirestoreDatabaseArguments(database) {
  return [
    "firestore",
    "databases",
    "create",
    `--database=${database.id}`,
    `--location=${database.location}`,
    "--type=firestore-native",
    "--edition=standard",
    "--concurrency-mode=pessimistic",
    "--delete-protection",
    "--enable-pitr",
  ];
}

export function createFirestoreTtlUpdateArguments(database, collectionGroup) {
  return [
    "firestore",
    "fields",
    "ttls",
    "update",
    "ttlExpiresAt",
    `--collection-group=${collectionGroup}`,
    `--database=${database.id}`,
    "--enable-ttl",
    "--expiration-offset=0s",
    "--async",
  ];
}

export function createCloudRunDeploymentFoundationPlan() {
  return {
    controller: {
      account: {
        description: "Controls isolated ScribeDrop production Cloud Run GPU jobs.",
        displayName: "ScribeDrop production GPU controller",
        email: `gpu-controller-production@${PROJECT_ID}.iam.gserviceaccount.com`,
        id: "gpu-controller-production",
      },
      database: {
        id: "scribe-production-controller",
        location: "asia-southeast1",
        pitr: true,
        ttlCollectionGroups: [
          "scribe_drop_controller_executions",
          "scribe_drop_controller_requests",
        ],
      },
      primarySecret: {
        id: "scribe-drop-production-controller-primary",
        labels: {
          "scribe-drop-component": "gpu-controller",
          "scribe-drop-environment": "production",
        },
        location: "asia-southeast1",
      },
      runtimeAccount: {
        description: "Runs isolated ScribeDrop production Cloud Run GPU jobs.",
        displayName: "ScribeDrop production GPU runtime",
        email: `gpu-runtime-production@${PROJECT_ID}.iam.gserviceaccount.com`,
        id: "gpu-runtime-production",
      },
      service: {
        id: "scribe-drop-production-gpu-controller",
        region: "asia-southeast1",
      },
    },
    deploymentRole: {
      description: "Minimum control-plane access for ScribeDrop release environment deployment.",
      id: "scribeDropReleaseDeployer",
      name: `projects/${PROJECT_ID}/roles/scribeDropReleaseDeployer`,
      permissions: [...deploymentRolePermissions],
      stage: "GA",
      title: "ScribeDrop release deployer",
    },
    stagingBootstrapPreflightRole: {
      description:
        "Reads exact L4 quota and creates, verifies, executes, and removes the staging GPU-free bootstrap preflight.",
      id: "scribeDropStagingBootstrapPreflight",
      name: `projects/${PROJECT_ID}/roles/scribeDropStagingBootstrapPreflight`,
      permissions: [...stagingBootstrapPreflightRolePermissions],
      stage: "GA",
      title: "ScribeDrop staging bootstrap preflight",
    },
    stagingBootstrapPreflightService: "cloudquotas.googleapis.com",
    existingControllerRoles: [
      {
        description: "Minimum Cloud Run Jobs permissions for the ScribeDrop GPU controller.",
        id: "scribeDropCloudRunController",
        name: `projects/${PROJECT_ID}/roles/scribeDropCloudRunController`,
        permissions: [
          "run.executions.cancel",
          "run.executions.delete",
          "run.executions.list",
          "run.jobs.create",
          "run.jobs.delete",
          "run.jobs.get",
          "run.jobs.run",
          "run.operations.get",
        ],
        stage: "GA",
        title: "ScribeDrop Cloud Run controller",
      },
      {
        description: "Minimum Firestore transaction permissions for the ScribeDrop GPU controller.",
        id: "scribeDropFirestoreController",
        name: `projects/${PROJECT_ID}/roles/scribeDropFirestoreController`,
        permissions: [
          "datastore.databases.get",
          "datastore.entities.create",
          "datastore.entities.delete",
          "datastore.entities.get",
          "datastore.entities.update",
        ],
        stage: "GA",
        title: "ScribeDrop Firestore controller",
      },
    ],
    identities: [
      deploymentIdentity("staging", ".github/workflows/deploy-staging-candidate.yml"),
      deploymentIdentity("production", ".github/workflows/deploy-production-candidate.yml"),
    ],
    projectId: PROJECT_ID,
    projectNumber: PROJECT_NUMBER,
  };
}
