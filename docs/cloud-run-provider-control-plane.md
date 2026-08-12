# Cloud Run provider control-plane設計

## 1. Status and scope

- Status: `Implementation selected`、Phase 12/13 local implementation完了、cloud未接続
- Date: 2026-08-11
- Decision: [ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)
- Product routing: 現行RunPod Serverlessのまま

この文書はPhase 12からPhase 14のsynthetic-only実装境界を固定する。cloud resource、credential、CI、
staging、productionを変更する実行手順ではない。実録音、R2 capability、利用者metadataをcontrollerへ渡さない。

## 2. Components and trust boundaries

```text
Cloudflare Orchestrator
  -> environment-scoped HMAC-authenticated mutation request
    -> dedicated Cloud Run controller Service
      -> regional Firestore control records
      -> Cloud Run Admin API v2
        -> one ephemeral GPU Job
          -> one server-generated Execution / one Task / one L4

GPU runtime
  -> Google-signed service identity + one-time challenge
    -> Orchestrator
      -> controller bounded live attestation
```

- Orchestratorはprovider-neutral execution aggregate、attempt CAS、bootstrap challengeの正を保持する。
- controllerは固定policyからだけJobを作成・観測・cancel・deleteし、provider raw型を外へ返さない。
- Firestoreはrequest replay、provider operation、active count、budget reservationの正を保持する。利用者dataは持たない。
- GPU runtimeはGoogle Cloud control credentialを持たず、controllerを直接操作しない。
- Cloud Run Admin APIとFirestoreを呼ぶprincipalはcontroller service identityだけとする。

## 3. Fixed policy

| Boundary         | `cloud_run_jobs_l4_v1`                                                        |
| ---------------- | ----------------------------------------------------------------------------- |
| environment      | stagingまたはproductionの固定controller deployment。requestとの完全一致が必要 |
| region           | `asia-southeast1`                                                             |
| runtime          | Cloud Run Job、second generation execution environment                        |
| GPU              | NVIDIA L4 x 1、no zonal redundancy                                            |
| compute          | 4 vCPU、16 GiB memory                                                         |
| task             | task 1、parallelism 1、retry 0、timeout 3,300秒                               |
| scratch          | `/tmp`だけ、3 GiB size-limited in-memory volume                               |
| image            | release candidateのimmutable Artifact Registry digest                         |
| supply chain     | Binary Authorization default policy、policy override/breakglass禁止           |
| command          | fixed one-shot runtime entrypoint、override禁止                               |
| runtime identity | environment専用user-managed service account、project role 0、key 0            |
| network          | listenerなし、inboundなし、default outbound、application HTTPS allowlist      |
| storage          | persistent volume、Cloud Storage mount、secret volumeなし                     |
| execution        | environmentごとにactive 1以下、JobごとにExecution 1以下                       |

callerはpolicy ID、environment、opaque execution handle以外のresource specを送らない。image、GPU、region、
CPU、memory、task count、parallelism、retry、timeout、command、args、environment、label、network、volume、
service accountをrequestから指定またはoverrideした場合はschema境界で拒否する。

## 4. Controller request contract

すべてのmutation requestはstrict schemaで次だけを受ける。

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "action": "create",
  "requestId": "opaque-ulid",
  "executionHandle": "opaque-random-handle",
  "policyId": "cloud_run_jobs_l4_v1",
  "expectedVersion": 0,
  "issuedAt": "UTC timestamp",
  "expiresAt": "UTC timestamp"
}
```

- controllerはenvironment別に256 bit以上のrandom HMAC-SHA-256 secretを持つ。request signatureはHTTP method、
  exact path、issued time、expiry、request ID、canonical body SHA-256を長さ付きで結合した値を対象にする。
- `keyId`はprimary/secondaryの固定rotation slotだけを許可し、unknown key、algorithm、encodingを拒否する。
- signatureはconstant-time比較し、検証前にbody sizeを制限する。secret、signature、canonical inputをlogへ出さない。
- request lifetimeは最大60秒、clock skewは最大30秒とし、expired requestを再実行しない。
- request bodyのcanonical digestを保存する。同じrequest IDと同じdigestは同じbounded responseへ収束し、
  digest、environment、handle、actionのいずれかが違う再利用はconflictとする。
- browser Access JWT、利用者Access identity、任意bearer token、Cloudflare Access headerをcontroller認証の代替にしない。
- request/response body、signature、resource refをlogへ出さない。logはaction、outcome、safe error code、duration、
  policy versionのallowlistだけとする。

Cloud Run Serviceのdefault URLはinternetから到達可能であり、platform IAMではなくapplication HMACがmutationを保護する。
valid signatureがなければGPU mutation前に拒否する。GCP keyをCloudflareへ置かず、controllerがfixed policyとhard budgetを
独立強制するための明示的trade-offである。Phase 14ではmissing/wrong key、body/path改変、expired request、replay、
secret rotation、direct URL、unauthenticated DoSを実serviceで検証する。

## 5. IAM and credential scope

### Cloudflare

- Orchestrator secretはenvironment別controller HMAC secretだけとする。
- HMAC secretはcontroller mutation protocol以外に使わず、browser applicationや別environmentと共有しない。
- key IDを変えたprimary/secondaryのbounded overlapでrotateし、旧keyの受付期限を固定する。
- Google service account key、OAuth refresh token、gcloud credentialをCloudflare secretへ置かない。

### Controller service identity

IAMは[ADR 0078](./adr/0078-split-controller-iam-by-resource-boundary.md)に従い、resource boundaryごとに分割する。
project custom role `scribeDropCloudRunController`は次のpermissionだけを含める。

- `run.jobs.create`, `run.jobs.get`, `run.jobs.delete`, `run.jobs.run`
- `run.executions.list`, `run.executions.cancel`, `run.executions.delete`
- `run.operations.get`

Firestore custom role `scribeDropFirestoreController`は`datastore.databases.get`と
`datastore.entities.get/create/update/delete`だけを含め、project policyの
`resource.name == "projects/{project}/databases/{database}"`条件でdedicated databaseへ限定する。
さらにcontroller principalへ次を別々に付与する。

- dedicated runtime service account上の`roles/iam.serviceAccountUser`
- exact Artifact Registry repository上の`roles/artifactregistry.reader`
- exact Secret Manager secret上の`roles/secretmanager.secretAccessor`

Cloud Run Serviceはsecretの数値versionだけを参照する。SecretVersion単位のIAM bindingがあるとは扱わない。

`run.jobs.update`、`run.jobs.runWithOverrides`、service/worker pool mutation、IAM policy mutation、Artifact Registry
write/delete、service account key/admin、quota/billing mutationを含めない。predefined `roles/run.developer`をruntime
principalへ付けず、custom role permissionとcontroller principalのresource別bindingをdeployment manifestとread-back verifierへ固定する。

### GPU runtime identity

- runtime service accountはcontroller用accountと分離する。
- project role、user-managed key、Artifact Registry、Firestore、Cloud Run Admin権限を0にする。
- `GOOGLE_APPLICATION_CREDENTIALS`を設定しない。metadata serverからOrchestrator専用audienceのID tokenだけを取得する。
- tokenをlog、artifact、provider outputへ出さず、bootstrap requestだけに使う。

## 6. Durable admission and budget

Firestoreのenvironment singleton documentとrequest documentを一つのtransactionで更新する。

1. environment、policy、authorization epoch、price snapshot expiryを検証する。
2. active executionが0であることを確認する。
3. request IDが未使用、または同一digestのexact retryであることを確認する。
4. authorized execution countとworst-case JPY残高を確認する。
5. execution count 1とworst-case全額をreserveし、`create_intent`をcommitする。
6. commit成功後だけCloud Run APIを呼ぶ。

synthetic authorizationのdefaultはexecution 0、budget 0円とする。cloud packetはGPU、CPU、memory、controller、
Artifact Registry、Firestore、Secret Manager、network、taxを含むfresh worst-caseと有限execution countを提示し、
利用者承認後だけauthorization epochへ設定する。Phase 10Dの220円上限と24時間repository reserveは隔離probe専用で、
新しいpersistent control planeへ流用しない。actual billing反映を理由にreservationを後から増やさない。price expiry、
quota不明、Firestore transaction failureではprovider mutationを行わない。

Firestore recordはprovider cleanupと監査に必要な期間だけ保持し、31日後のTTL対象とする。TTL削除は即時でないため、
expiry後もrecordが存在し得ることをreplay判断と運用文書へ反映する。TTL対象recordへapplication dataやcredentialを
保存しない。

## 7. Create and run protocol

### 7.1 Job create

1. `create_intent`からenvironment、policy、handleを読み、Job IDを決定的に導出する。
2. fixed policyだけからCloud Run v2 Job bodyを生成する。
3. caller指定`jobId`でcreateし、Operationをbounded schemaへ変換する。
4. timeoutまたはresponse parse failureは`unknown_outcome`として同じJob IDをget/listする。
5. 既存JobがあればUID、etag、Binary Authorization default policyを含むmanifestを完全照合する。default policyの
   欠落、無効化、policy override、breakglassを含む不一致はresource driftとして実行せずcleanupする。
6. 404確認後にcreateを再試行する場合も同じJob IDだけを使う。別名、別region、別GPUへfallbackしない。
7. Operation完了とmanifest一致後にprovider refをFirestoreへ保存する。

同じJob IDのunique resource制約によりcreate effectは最大1へ収束する。HTTP timeout直後の404を
「create失敗確定」とはみなさず、bounded reconciliation window内は同じ名前だけを観測する。

### 7.2 Execution run

1. Jobのready状態、execution count 0、etag、fixed manifestを直前に再確認する。
2. Firestore transactionで`run_intent`とattempt count 1をcommitする。
3. `POST .../jobs/{job}:run`をetag付き、overrideなしで一度だけ送る。
4. responseがOperationを返した場合も、Job配下のExecutionをlistし、server生成nameとUIDを保存する。
5. timeout、response loss、controller restartでは`jobs.run`を再送しない。同じJobのExecution list、Jobの
   `executionCount`と`latestCreatedExecution`、既知Operationだけをpollする。
6. Execution 1件ならexact resourceへ収束する。2件以上はsecurity invariant failureとして全件cancel/cleanupする。
7. provisioning deadlineまで0件なら`unknown_outcome`を維持し、同じattemptへ新Executionを作らない。

`jobs.run`にidempotency keyがないため、0件の自動再送によるavailability回復を禁止する。このlossは新しいproduct
attemptを利用者が明示作成するまで回復しない。

## 8. Observation and identity binding

controllerはExecutionから次をbounded schemaへ写す。

- Job UID、Execution immutable UID、parent、create/start/completion time
- reconciling、terminal condition、running/succeeded/failed/cancelled/retried count
- task count、parallelism、retry、timeout
- immutable image digest、command、environment allowlist、runtime service account
- Binary Authorization default policy、policy override/breakglass不在
- L4 count、CPU、memory、scratch、volume/networkのfixed policy一致

runtimeはGPU/model初期化前にCloud Run組み込みJob/Execution/task変数をstrict検証し、opaque handle、bootstrap request ID、
ephemeral public key、Google署名service identity tokenをOrchestratorへ送る。Orchestratorは次をすべて確認する。

1. ID tokenのsignature、issuer、audience、time、専用runtime service account subject。
2. 未使用challenge、request ID、public key digest、handleのCAS一致。
3. controllerが同じhandleへ返すexact live ExecutionのUID、Job UID、create time、manifest一致。
4. environment active executionが1件だけで、Execution task attemptが0、task count 1であること。
5. runtime申告の組み込みexecution名がcontroller read-backと一致すること。

Cloud Run ID tokenはExecution UIDをclaimへ含めないため、3〜5はprovider署名attestationではない。専用runtime identityの
他resource利用0とsingle-active invariantが崩れた場合、capabilityを発行せずcleanupする。Phase 13はsynthetic
capabilityだけでこのprotocolを実装し、Phase 15 acceptanceが残余リスクを再判定する。

## 9. Network and data location

- GPU JobはHTTP listenerを起動せず、Cloud Run Serviceやingress routeを持たない。
- controllerだけがHTTP Serviceで、internet-reachable default URL上のHMAC-authenticated mutationだけを受ける。
- GPU Jobのoutboundはexact Orchestrator originと、bootstrap後に渡されるexact R2 capability originだけをapplication
  allowlistへ入れる。HTTPS port 443、credential-free URL syntax、redirect拒否、DNS/IP再検証を維持する。
- default outboundはnetwork-level domain allowlistではない。Direct VPC egress、proxy、firewallを導入しない初期選択を
  threat modelへ残し、production adoptionで再評価する。
- Cloud Run Job、controller、Artifact Registry、FirestoreはSingaporeへ固定する。tracked文書へproject、database、
  repository、service accountの実IDを残さない。
- Phase 12〜14は合成fixtureだけを使う。実録音をR2からSingaporeへ転送することはPhase 15のprivacy/data-location
  acceptanceまで禁止する。

## 10. Timeout, cancellation, cleanup

- task timeoutは3,300秒で、GPU上限1時間より短く固定する。
- retry 0、task 1、parallelism 1を毎回read-backする。OOM、timeout、infrastructure failureでresourceを増量して
  retryしない。
- Orchestratorの既存scheduled reconciliationがcontrollerのbounded reconcile endpointを呼ぶ。controller停止中も
  provider task timeoutがGPU taskをstopするため、Cronをhard lifetimeの代替にしない。
- cancelはexact Execution nameとetagへ一度送り、timeout後は同じExecutionをgetする。
- terminal確認後にExecution delete、Job deleteをetag付きで行い、Job/Execution listからabsenceを確認する。
- delete outcome不明、provider read outage、unexpected second Executionではbudget reservationとrecordを残し、
  orphan reaperが同じresourceだけを回収する。
- Job delete受理、container exit、terminal reportのいずれか一つだけでcleanup completeにしない。

## 11. Error mapping

| Provider observation                       | Domain result                                       |
| ------------------------------------------ | --------------------------------------------------- |
| quota/capacity rejection before effect     | `retryable`またはbounded `permanent`、capability 0  |
| invalid fixed manifest / permission denied | `permanent`                                         |
| create conflict with exact manifest        | idempotent observation                              |
| create conflict with drift                 | `conflict`、cleanup required                        |
| create/run/cancel/delete timeout           | `unknown_outcome`                                   |
| Execution pending/reconciling              | `pending`                                           |
| task running                               | `running`                                           |
| succeeded 1、failure/cancel/retry 0        | `succeeded` observation。product completionではない |
| failed/cancelled/timeout                   | matching terminal observation                       |
| execution count 2以上                      | invariant failure、all exact resources cleanup      |
| cleanup absence confirmed                  | cleanup `succeeded`                                 |

raw Google error message、response body、resource URLをdomain errorへ含めない。status code、operation state、
allowlist reasonからsafe error kindへ変換する。

## 12. Phase gates

### Phase 12

- `apps/gpu-controller`にprovider API、durable store、clock、HMAC key store、networkをport化したcontrollerを
  local実装した。production adapterはCloud Run v2 responseをbounded schemaへ射影し、redirect、oversized、
  malformed body、scope外resource refをunknownまたは拒否へ閉じ込める。Firestore adapterとservice hostingはPhase 14である。
- timeout-after-effect、duplicate/changed replay、second execution、stale version、restart、wrong environment、
  arbitrary override、rate/budget failure、cleanup unknownをlocal fakeで検証した。
- synthetic authorizationは引き続きcount 0、budget 0、rate 0がdefaultである。cloud resource、credential、
  product Worker/container、CIは変更していない。

### Phase 13

- [ADR 0077](./adr/0077-use-two-step-runtime-bootstrap-challenge.md)に従い、two-step challenge、memory-only
  Ed25519、strict HTTP/Pydantic/Zod contract、ack/heartbeat/terminal/session revoke、cleanup scheduleをlocal実装した。
- offline modelを持つfixed one-shot imageをbuildし、network none、read-only、non-root、GPU mock、8時間bounded core、
  SBOM、HIGH/CRITICAL scanを通した。詳細は[one-shot runtime](./cloud-run-one-shot-runtime.md)を正とする。
- R2 production capability、実録音、cloud resource、credential、CI、product routingは変更していない。

### Phase 14

- official Firestore clientのnamed-database adapterをlocal実装した。environment singleton、global request ID、execution
  recordをtransactionで読み書きし、SDKによるtransaction callback再実行中に外部副作用を起こさない。active slotは
  exact cleanup後だけ解放し、lifetime execution countとworst-case JPY reservationは解放しない。
- persisted documentはstrict Zod schemaで検証し、authorization epoch、policy、path/body handle、bootstrap request、TTL、
  active singleton、reservation accountingのdriftをfail closedにする。request/executionへ31日TTL fieldを保存するが、
  database作成とTTL policy設定はまだ行わない。
- [ADR 0079](./adr/0079-fix-controller-firestore-database-and-ttl-policy.md)のpure resource planとstrict read-backを追加した。databaseは
  Singapore/Native/Standard、pessimistic concurrency、delete protection、Firestore-only APIへ固定し、staging PITR無効、production PITR
  有効を分離する。request/executionの`ttlExpiresAt`だけをoffset 0かつ`ACTIVE`で受ける。individual field GETとdatabase-wide
  `ttlConfig:*` listを2回実行し、期待2件以外、重複、paginationを拒否するlocal clientはlist順序だけを正規化し、volatileな
  `earliestVersionTime`だけを比較から除外する。Service/security、IAM、Firestoreを同じdeployment configから導出する
  atomic evidence verifierと、全固定endpointを一つのtoken/quota project・double-snapshot windowで読むdeployment-level clientも追加した。
  個別clientとendpoint builderを共有するが、実credential、database/TTL作成、mutationは行わない。
- local composition rootはmanifest、authorization、Firestoreのenvironment/projectを完全一致させ、imageとruntime service
  accountも同じprojectへ限定する。disabled authorizationは署名済みrequestでもADC token取得とprovider HTTPより先に止める。
- Cloud Run Admin用tokenはGoogle ADCから取得し、20〜8,192 byteのvisible ASCIIだけをAuthorization headerへ渡す。HMAC
  primary/secondaryはcanonical base64urlでdecodeした32〜64 byteだけをmemoryに保持し、同一rotation keyを拒否する。
- 共有contract、HMAC framing、controller live attestation endpoint、Orchestratorのbounded attestation/cleanup clientを
  local実装した。attestationはstoreだけで成功せず、JobとExecutionをlive read-backしてexact count、UID、manifest、
  service account、task/retryを照合する。cleanup response lossは再送せずunknownへ閉じる。
- Google OAuth JWKSのbounded fetch/cacheとRS256 verifierをlocal実装し、exact issuer/audience/time、`sub == azp`、verified
  service-account emailを検証する。数値subject IDとemailは別fieldとして扱う。
- Firestore adapter、composition root、ADC/HMAC adapter、Node HTTP entrypointはlocal結線した。Secret Manager version binding、
  controller container/service hosting、実listenは未接続で、cloud mutationを行わない。controller Serviceのpure deployment planと
  normalized read-back verifierはSingapore/Gen2、immutable image、dedicated identity、bounded scaling/resource/traffic、public HMAC
  ingress、Binary Authorization default policy、fixed secret version、environment allowlistを固定する。raw Cloud Run v2 adapterと
  IAM/Secret Manager/Binary Authorizationのstrict observation verifier、必須read-backを束ねるatomic evidence verifierもlocal実装した。
  固定Google API endpointへのGETと`getIamPolicy`だけのread-only POST、bounded、double-snapshot clientもlocal実装した。実credentialとauthoritative live
  observationへは未接続である。
- GPU Job manifestにもBinary Authorization default policyを固定し、Cloud Run v2 Job read-backで欠落、無効化、
  policy override、breakglassを拒否する。project default policyとexact attestorのauthoritative read-back、worker imageへの
  attestation発行は実staging gateに残す。
- 別review packetと明示承認後だけ、environment分離した最小staging resourceへ接続する。
- exact synthetic execution countと費用を事前固定し、cleanup/parityをread-backする。

### Phase 15 and production

- service identityのExecution非結合、default outbound、Singaporeへのdata transfer、HMAC-protected public controller、
  capacity、budget、CI identity、rollbackをformal staging acceptanceで再判定する。
- successful acceptanceと別`Production adopted` ADRなしにPhase 16 routingを変更しない。

## 13. Official references

- [Create a Cloud Run Job](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/create)
- [Run a Cloud Run Job](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
- [List Job Executions](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions/list)
- [Cloud Run Execution resource](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions)
- [Cloud Run task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [Google Cloud token types](https://cloud.google.com/docs/authentication/token-types)
- [Google ID token server-side verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Cloud Run IAM permissions](https://docs.cloud.google.com/run/docs/reference/iam/permissions)
- [Cloud Run locations](https://cloud.google.com/run/docs/locations)
- [Cloud Run authentication overview](https://docs.cloud.google.com/run/docs/authenticating/overview)
- [Enable Binary Authorization for Cloud Run](https://docs.cloud.google.com/binary-authorization/docs/run/enabling-binauthz-cloud-run)
- [Firestore transactions](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions)
- [Firestore locations](https://docs.cloud.google.com/firestore/docs/locations)
- [Firestore TTL](https://docs.cloud.google.com/firestore/native/docs/ttl)
- [Firestore Admin fields.list](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.collectionGroups.fields/list)
