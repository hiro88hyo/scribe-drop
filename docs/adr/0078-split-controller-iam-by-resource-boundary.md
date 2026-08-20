# ADR 0078: controller IAMをresource boundaryごとに分割する

## Context

Phase 14のcontroller identity設計は、Cloud Run Jobs操作、runtime service accountの`actAs`、Artifact Registry read、
Firestore data、Secret Manager accessを一つのcustom roleへ含めるとしていた。しかしrole definitionとrole bindingは別の境界であり、
一つのproject bindingではrepository、service account、database、secretごとのscopeを表現できない。

実装済みcontroller clientが使うCloud Run permissionはJob create/get/delete/run、Execution list/cancel/delete、Operation getだけである。
`run.jobs.list`、`run.executions.get`、Job update、override付きrun、IAM mutationは使用しない。Firestore adapterは固定documentへの
transactional get/create/update/deleteだけを使い、query、index、database管理を行わない。Secret ManagerはCloud Run Serviceの
fixed-version environment injectionに使い、controllerのGoogle API clientがpayloadを取得しない。

## Decision

- project custom role `scribeDropCloudRunController`には次だけを含める。
  - `run.jobs.create`, `run.jobs.get`, `run.jobs.delete`, `run.jobs.run`
  - `run.executions.list`, `run.executions.cancel`, `run.executions.delete`
  - `run.operations.get`
- Firestore用custom role `scribeDropFirestoreController`には次だけを含める。
  - `datastore.databases.get`
  - `datastore.entities.get`, `datastore.entities.create`, `datastore.entities.update`, `datastore.entities.delete`
- Cloud Run roleはcontroller principalへproject policyで付与する。
- Firestore roleは同じproject policyで付与するが、`resource.name == projects/{project}/databases/{database}`の完全一致条件を必須とする。
- dedicated runtime service accountには`roles/iam.serviceAccountUser`をresource-levelで付与する。
- worker image repositoryには`roles/artifactregistry.reader`をrepository-levelで付与する。controllerはJob deployerとしてimage readを必要とし、
  Cloud Run service agentのimage accessとは別に検証する。
- HMAC secretには`roles/secretmanager.secretAccessor`をsecret-levelで付与し、Cloud Run Serviceは数値versionだけを参照する。
  SecretVersion単位のIAM bindingが存在するとは扱わない。
- project policyのread-backは他principalのbindingを許容する一方、controller principalを含むbindingだけを抽出し、上記2件との完全一致を要求する。
  controller principalを他principalと同一bindingへ混在させず、追加role、条件欠落、条件差分を拒否する。
- custom role definitionはpermission集合、stage、deleted状態をraw read-backで完全照合する。
- local read-only clientはcustom roleをGETし、project、repository、runtime service accountの`getIamPolicy`だけを呼ぶ。HTTP上POSTが必要な
  endpointはpathとbodyを固定し、`setIamPolicy`を許可しない。同じtoken/quota projectで2回取得し、途中変更を拒否する。

## Consequences

- controller principalのeffective authorityをresource boundary別に監査でき、単一の広いproject roleとして誤認しない。
- Cloud Run Job createはproject-level permissionであり、IAMだけで任意Job名を完全には制限できない。Singapore、名前、image、GPU、command、
  budgetはcontrollerのfixed manifestとdurable admissionでも引き続き強制する。
- project policy取得にはCloud Resource Managerのread-only `getIamPolicy`が必要であり、HTTP上POSTであってもmutationとして扱わない。
  local clientは許可origin/path、policy version 3 body、10秒timeout、256 KiB response上限を固定するが、実credentialではまだ実行しない。
- role作成、binding変更、API有効化、CI変更はこのADRでは許可しない。

## Status

Accepted
