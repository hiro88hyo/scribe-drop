# ADR 0076: Cloud Run Jobsをsynthetic-only provider実装に選定する

- Status: Accepted
- Date: 2026-08-11
- Target release: `0.2.0`
- Relates to: ADR 0066、ADR 0067、ADR 0070、ADR 0071、ADR 0074、ADR 0075
- Supersedes for active implementation: ADR 0066のRunPod Pods案
- Does not authorize: cloud mutation、CI変更、実録音、staging/production接続、production routing

## Context

[ADR 0071](./0071-separate-provider-selection-from-production-adoption.md)はprovider判断を
`Technical candidate`、`Implementation selected`、`Production adopted`の3段階に分けた。
Cloud Run GPU JobはADR 0070で旧bounded candidateの技術候補となった後、adaptive EOFを含むexact
worker imageについてPhase 10Cのlocal CUDA/float16 quality gateとADR 0075のCloud Run L4
revalidationを通過した。revalidationはexact one execution、task attempt 1、retry 0で成功し、必要metricを
欠測なく取得した後、全専用resource 0を独立確認した。

Phase 12を開始するには、単発GPU成功だけでなくprovider API、resource identity、IAM、createとrunの
結果不明、network、data location、hard timeout、cleanup、quota、費用を実装可能な境界へ固定する必要がある。
特にCloud Run Admin API v2のJob createはcaller指定`jobId`を持つ一方、`jobs.run`にはidempotency keyがなく、
成功時はserver生成Executionを含むlong-running Operationを返す。timeout後に`jobs.run`を再送して
exactly-onceを推測することはできない。

Cloud Runのservice identityはGoogle署名ID tokenで専用service accountを証明できるが、そのtokenは
Cloud Run Execution UIDを署名対象にしない。このためservice identityを暗号学的なinstance attestationと
呼ばず、single active execution、one-time challenge、provider live read-backを合わせたoperational bindingとして
扱う必要がある。

RunPod Pods比較案はpublic IP、create idempotency、provider署名instance identity、provider hard lifetimeが
未解決のままで、active probeも停止している。現行RunPod Serverlessはproduction採用済み経路として維持するが、
新しいprovider-neutral execution実装の選定先にはしない。

## Decision

- Cloud Run Jobsを`Implementation selected`とする。許可範囲はPhase 12からPhase 14の非機密・合成dataだけであり、
  `Production adopted`ではない。
- normativeな実装境界は
  [Cloud Run provider control-plane設計](../cloud-run-provider-control-plane.md)とする。
- provider policyを`cloud_run_jobs_l4_v1`に固定する。regionは`asia-southeast1`、L4 1台、4 vCPU、
  16 GiB、task 1、parallelism 1、retry 0、task timeout 55分、no zonal redundancy、`/tmp` 3 GiB
  size-limited in-memory volume、immutable image digest、固定commandとする。caller overrideは一切受けない。
- provider control planeは同じregionの専用Cloud Run Serviceとして分離する。Cloudflare Orchestratorは
  Google Cloud credentialを保持せず、environment別256 bit以上のcontroller HMAC secretでrequest method、path、
  timestamp、request ID、canonical body digestを認証する。controllerはsecret key ID、signature、時刻、request digestを
  provider mutation前に検証する。
- controllerのservice identityには、固定regionのJob create/get/list/delete/run、Execution
  get/list/cancel/delete、Operation get、専用runtime service accountへの`actAs`、固定Artifact Registry
  repositoryのread、専用Firestore databaseのcontrol record read/write、exact controller authentication secretの
  Secret Manager accessだけを許可する。Job update、
  run-with-overrides、IAM変更、service mutation、image write、quota/billing mutationを許可しない。
- GPU runtimeはenvironment別の専用user-managed service accountを使い、project roleとuser-managed keyを0にする。
  controller credential、controller HMAC secret、Google service account keyをGPU Jobへ渡さない。
- request ID、request digest、opaque execution handle、provider resource reference、state、deadline、budget reservationを
  `asia-southeast1`の専用Firestore databaseへ保存する。application data、R2 capability、利用者ID、job ID、
  attempt ID、filename、本文は保存しない。transactionでreplay、同時admission、費用reservationを直列化する。
- Job名はenvironment、policy、opaque execution handleから決定的に導出し、同じrequestは同じ名前へ収束させる。
  Job create timeout後は同じ名前をget/listし、別名を作らない。同じ`jobId`へのcreate再試行はresource最大1を
  維持する場合だけ許可する。
- exact Jobのmanifestとetagをread-backした後、Firestoreへ`run_intent`をcommitしてから`jobs.run`を一度だけ
  送る。override bodyは使わずetagだけを指定する。response loss、timeout、controller restartのいずれでも
  `jobs.run`を再送せず、同じJob配下のExecution listとOperationからだけ収束させる。0件のままなら
  availabilityを捨てて`unknown_outcome`とし、新しいexecutionを作らない。
- Executionはserver生成nameと不変UID、parent Job、create time、image digest、runtime identity、task count、
  parallelism、retry、timeoutをlive read-backする。GPU runtimeは専用service identityのGoogle署名ID token、
  Cloud Run組み込みexecution名、opaque handle、一回性challengeをOrchestratorへ提示する。Orchestratorはcontrollerの
  bounded attestationと照合し、single active executionが成立した後だけ後続bootstrapを許可する。
- 上記identityはexact Executionを署名するprovider attestationではない。別workloadへのruntime service account流用、
  active execution複数、read-back不一致、challenge replayではfail closedにする。この残余リスクをPhase 15の
  production adoptionで再評価し、黙ってhost attestationへ格上げしない。
- GPU Jobはlistenerとinbound endpointを持たない。初期実装はexternal R2とOrchestratorへHTTPS接続するため
  default outboundを使い、application clientのexact HTTPS origin、port 443、redirect拒否、DNS/IP再検証を維持する。
  network層のdomain allowlistではないことを残余リスクとする。Phase 12はnetwork fakeだけ、Phase 14までは
  synthetic dataだけを使う。
- Cloud Run Job、controller、Artifact Registry、Firestoreは`asia-southeast1`へ固定する。Cloud Run resourceに
  関連するcustomer dataは選択regionへ置かれる一方、R2からSingaporeへの転送とprovider処理は越境になり得る。
  実録音を許可する前にprivacy、契約、R2 jurisdictionをPhase 15で明示承認する。
- provider hard lifetimeはGPU task timeout 55分とする。GPU taskは最大1時間で、timeoutしたattemptはCloud Runが
  stopする。retry 0、task 1のためExecutionはそのtaskの終了へ収束する。application watchdogとreaperは補助であり、
  55分を延長しない。
- cleanupはexact Execution cancel、terminal read-back、Execution delete、Job delete、absence read-backの順とする。
  各mutation timeoutは結果不明として同じresourceだけをreconcileする。JobまたはExecutionの不在を推測せず、
  provider APIで確認するまでcontrol recordを消さない。
- quotaはfixed regionのL4 no-zonal effective quota 1以上をadmission前にread-only確認し、初期active GPU executionを
  environmentごとに1へ固定する。capacityは予約とみなさず、別region、別GPU、RunPodへ暗黙fallbackしない。
- synthetic implementationのbudgetはexecution count 0、0円のdefault denyに固定する。cloud mutationを伴うPhaseでは
  controller Service、Artifact Registry、Firestore、Secret Manager、network、GPU Job、税を含むworst-caseをfresh
  Billing Catalogから計算し、review packetと明示承認でauthorization epochごとの有限countとJPY上限を設定する。
  Firestore transactionでworst-case全額をreserveし、expired price snapshot、上限超過、budget record不在ではcreateしない。
  Phase 10Dの220円上限は隔離probe専用であり、新control planeへ流用しない。production budgetはPhase 15後の別ADRなしに
  設定しない。
- provider raw body、Google project/account、service account email、Job/Execution/Operation名、HMAC header、
  resource URLをapplication logへ出さない。provider referenceはcontroller内部だけで保持し、Orchestratorとの契約は
  opaque execution handleとbounded state/errorだけにする。
- このADRは設計とlocal実装開始だけを許可する。controller Service、Firestore、Artifact Registry、IAM、Secret Manager、
  DNS、Job、credential、CIを作成または変更するには、対象Phaseのreview packet、fresh read-back、費用提示、利用者の
  明示承認を別途必要とする。

## Phase 8 packetとの差分

| Boundary           | Phase 8 RunPod Pods案            | 選定したCloud Run Jobs境界                                             |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------- |
| provider API       | RunPod Pod create/read/terminate | Cloud Run Admin API v2 Job/Execution/Operation                         |
| resource           | Secure Cloud Podとstorage        | unique ephemeral Jobとserver生成Execution、persistent volumeなし       |
| inbound            | public IPのmandatory gap         | Jobはrequestをserveせずlistenerなし                                    |
| create idempotency | provider key未確認               | caller指定`jobId`、deterministic name、Firestore intent                |
| execution start    | createとprocess startが同一      | Job createと非冪等`jobs.run`を分離し、run再送禁止                      |
| identity           | provider署名Pod identity未確認   | Google署名service identity + challenge + single-active live read-back  |
| hard lifetime      | provider auto-delete未確認       | provider-enforced GPU task timeout 55分、retry 0                       |
| credential         | account-wide API key懸念         | GCP内controller service identity、Cloudflare側はcontroller専用HMACだけ |
| durable guard      | provider resource list中心       | regional Firestore transactionでreplay/concurrency/budgetを固定        |
| data location      | data center未固定                | compute/control stateをSingaporeへ固定、実録音はPhase 15まで禁止       |
| network            | Secure Cloud、public network gap | no inbound Job、default outbound + application allowlistの残余リスク   |
| cost               | deploy時Console単価              | default 0円、packetごとのfresh全resource見積、有限count/JPY reserve    |
| cleanup            | Pod/storage terminate            | exact Execution cancel/delete、Job delete、absence read-back           |

## Consequences

- Phase 12はCloud Run controller単独のlocal実装を開始できる。現行RunPod production path、product Worker、
  GPU container、contract v1 routingは変更しない。
- `jobs.run`の可用性は意図的に低くなる。response loss後にExecutionを発見できない場合、同じattemptを自動で
  再実行せずfail closedにする。重複GPU実行より安全停止を優先する。
- GCP credentialをCloudflareへ複製しない代わりに、専用controller Service、shared HMAC secret、Firestore、custom IAMが
  増える。これらのparity、rotation、cleanup、費用をPhase 14以降で検証する必要がある。
- service identityはExecution固有attestationではない。synthetic stagingでbindingとreplay防止を実証しても、
  production採用にはprivacy、provider trust、capacity、CI workload identity、rollbackを含む別判断が必要である。
- controller stateはcontrol metadataだけだが、resource referenceと監査recordを保持する。retentionとTTLを固定し、
  TTLが即時削除ではないことを運用上明記する。
- Cloud Runのon-demand GPU capacityは保証されない。quotaがあってもcapacity rejectionを通常のfailureとして扱い、
  availabilityを理由にpolicyを緩めない。

## References

- [Cloud Run Admin API: create Job](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/create)
- [Cloud Run Admin API: run Job](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
- [Cloud Run Execution resource](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions)
- [Cloud Run GPU Job task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [Cloud Run locations](https://cloud.google.com/run/docs/locations)
- [Cloud Run IAM roles](https://docs.cloud.google.com/run/docs/reference/iam/roles)
- [Cloud Run authentication overview](https://docs.cloud.google.com/run/docs/authenticating/overview)
- [Firestore transactions](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions)
- [Firestore locations](https://docs.cloud.google.com/firestore/docs/locations)
- [ADR 0071](./0071-separate-provider-selection-from-production-adoption.md)
- [ADR 0075](./0075-revalidate-adaptive-eof-worker-before-provider-selection.md)
