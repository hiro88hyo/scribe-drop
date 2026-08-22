# ScribeDrop Architecture

この文書は、実装済みの信頼境界、データフロー、状態遷移、冪等性と障害回復の全体像を
示す。プロダクト要件は[spec.md](./spec.md)、実装順序と未完了項目は
[implementation-plan.md](./implementation-plan.md)、個別判断は[ADR](./adr/)を正とする。

## システム境界

```text
Browser
  ├─ Cloudflare Access ─ Pages / React PWA
  ├─ Access JWT + CSRF ─ Pages Functions /api/*
  └─ exact-object temporary capability ─ R2 incoming object

R2 event ─ Queue ─ Orchestrator Worker ─ typed RunPod HTTP client ─ RunPod Worker
                         │                                      │
                         ├─ D1 state / outbox                    └─ exact attempt R2 capability
                         ├─ R2 verification and cleanup
                         └─ Discord webhook
```

信頼できる入力は存在しない。Pages FunctionsはAccess JWTを再検証し、変更APIではさらに
Origin、JSON Content-Type、CSRF、`owner_sub`を検証する。R2 event、Queue message、
RunPod response、manifest、環境変数もZodまたはPydanticで境界検証する。D1のユーザー向け
queryはアプリケーション側の事後filterではなく、SQL自体に`owner_sub`条件を含める。

Browserには長期R2 credentialを渡さない。upload時は単一source keyとmultipart actionだけ、
RunPodには単一attempt prefixの必要actionだけ、download時は単一artifactのGETだけを許す
短期capabilityを発行する。署名URL、token、録音、文字起こし本文はlog、D1、browser
storageへ保存しない。

## コードの依存方向

- `packages/contracts`: HTTP、Queue、RunPod、manifestのschemaと公開型。
- `packages/domain`: 状態遷移、保持期限、capability失効などの純粋ロジック。
- `packages/observability`: allowlist済みeventとfieldだけを受ける構造化logger。
- `packages/test-support`: fake、fixture、固定clock/ID。production codeから参照しない。
- `apps/web`: React UI、Pages Functions、D1/R2 adapter。
- `apps/orchestrator`: Queue/Cron handler、RunPod/R2/Discord/D1 adapter。
- `apps/runpod-worker`: media再検証、Whisper処理、artifact/manifest生成。

app間を直接importせず、共有するschemaと純粋ロジックだけをpackageへ置く。Cloudflare、
AWS SDK、React、HTTP clientはdomainから外し、時刻、乱数、外部APIはport越しに差し替える。

## ジョブデータフロー

1. Browserが認証済みAPIへjob作成を要求する。D1はowner、期待size、optionsと
   `UPLOADING`状態を保存し、exact source key用の短期upload capabilityを返す。
2. BrowserがR2へmultipart uploadし、APIへ完了を通知する。APIはR2 HEADのsize、
   content type、ETagをD1の期待値と照合してから`UPLOADED`へ遷移する。
3. R2 eventをQueue consumerが再検証し、同じjobを二重投入せず`PENDING` attemptを作る。
4. OrchestratorがRunPodへ投入する。HTTP timeoutは失敗確定にせず`SUBMISSION_UNKNOWN`として
   reconciliationへ渡す。claim時は[ADR 0052](./adr/0052-attest-runpod-placement-before-claim.md)
   に従い、job status由来のworker IDとPod詳細からendpoint、実行状態、immutable image、
   許可GPU、Secure Cloudを照合する。照合済みWorkerだけがwinnerとなり処理を開始する。
5. RunPod workerはsourceを`/tmp`へstreaming downloadし、byte count、ffprobe、durationを
   再検証する。成果物とcomplete manifestをattempt固有prefixへ書き、一時領域を必ず消す。
6. CronがRunPod terminal statusをD1へ保存し、manifest schemaと各artifactのR2 HEADを
   検証する。active attemptとversionのCASを満たす一つだけがjobを`COMPLETED`にする。
   同じCronの通知境界は未通知の`COMPLETED`と`FAILED`を集中走査してnotification outboxを
   作り、失敗経路ごとのenqueue漏れを防ぐ。
7. Browserはowner検証済みAPIから操作時だけexact artifact GET capabilityを取得してdownloadする。
   5 MiB以下ではR2をbounded streaming readし、size、content type、UTF-8を検証してraw text modalへ
   一時表示・明示copyできる。API responseやartifact本文をservice workerまたはbrowser storageへ渡さない。

## 状態遷移と競合制御

主要な正常系は次のとおりである。

```text
UPLOADING → UPLOADED → PENDING → SUBMITTING → RUNNING → COMPLETED
     │          │          │           │          ├────→ FAILED
     └→ EXPIRED └──────────┴───────────┴──────────┴────→ CANCELLED
                                     timeout → SUBMISSION_UNKNOWN → reconcile
```

retryはFAILED jobを上書きせず、新しいgeneration、attempt、token、result prefixを作る。
loser、stale generation、古いattemptはcurrent jobを更新できない。状態更新は期待status、
version、active attemptをWHERE条件に含むcompare-and-setであり、event、artifact、outboxは
一意制約を併用する。duplicate/out-of-order messageは成功済み状態を再利用するか安全な
conflictとして終了する。

notification outboxはjobごとに1行を持ち、現在のterminal通知の配送状態として再利用する。
FAILED通知後にretryしたjobは`notified_at`を消去し、次のFAILEDまたはCOMPLETEDで同じ行を
PENDINGへ戻す。通知履歴を状態遷移の正とせず、jobとeventを正とする。
formal stagingは合成破損M4Aを同じ境界へ通し、jobのexact `FAILED`と現在versionのoutbox
`SENT`を確認する。短命acceptanceはこの実配送、failure fixture削除、scale-to-zero復元を
独立checkとして含み、production workflowが再検証する。

RunPodがsubmissionを受理しても10分以内にwinner claimへ進まない場合は、
[ADR 0043](./adr/0043-bound-runpod-start-slo-and-staging-wait.md)に従ってactive attemptを
FAILEDへCAS遷移し、記録済みのexact provider jobだけをcancelする。cancel不確定時も
FAILEDをSUBMITTINGへ戻さず、Cronがcancelを再試行する。

単一GPUの供給不足をCIだけの問題として扱わない。
[ADR 0053](./adr/0053-use-mixed-availability-gpus-with-runtime-attestation.md)に従い、
stagingとproductionは`RTX 5090`、`RTX 4090`、`RTX PRO 6000 Blackwell Server Edition`の
固定順を使用し、
promotion時に公式REST APIでGPU順序の完全一致、全候補のSecure Cloud提供、2候補以上の
利用可能性を確認する。さらに[ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)に
従い、全候補が相異なる実Serverless GPU poolへ一意に対応することをmutation前に検証する。
全候補はCommunity Cloudにも提供されるため、各claimでは
ADR 0052の配置attestationによって
実Workerの`secureCloud=true`を必須とする。data centerはADR 0064の`Any Region`とし、
Compliance filterも`Any`とする。GPUの公式REST read-backとdata center/complianceの
Console-equivalent GraphQL read-backを結合して完全一致を検証し、更新時は旧capacityを
read-backできなければrollback不能としてmutation前に停止する。このfilterをSecure Cloud
保証の代替にしない。
全候補が不足した場合も開始SLO、FAILEDへのCAS、exact cancelを維持し、無期限待機や
同じattemptの自動再投入は行わない。

staging release gateでは[ADR 0051](./adr/0051-prewarm-staging-before-job-creation.md)に従い、
一時的に`workersMin=1`としてcandidate Workerの実割り当てとreadinessを確認してから
synthetic jobを作る。全結果で`workersMin=0`へ戻し、productionのFlex構成を常時Activeへ
暗黙に変更しない。inventoryの`available`はpromotion前提であり、ready evidenceではない。

## 削除と保持期限

ユーザー削除はowner/CSRF検証後に`deleted_at`をCAS更新し、通常APIから直ちに隠す。
heartbeatを失効させ、`deletion_not_before`の前後にかかわらず既知RunPod jobのcancelを
確認する。最後のR2 capabilityの最大寿命とgraceが過ぎてからD1由来のexact source keyと
全attempt prefixだけを削除する。R2不存在は成功扱い、
失敗は上限付きbackoffで再試行し、すべてのobject不存在を確認してからD1親rowをcascade
物理削除する。長期tombstoneは残さない。詳細は
[ADR 0018](./adr/0018-asynchronous-user-deletion.md)を参照する。

通常保持期限はsource、attempt results、job auditを独立して回収する。source削除後は
同じ録音を使うretryを拒否するが、resultsはその期限までdownloadできる。R2 lifecycleは
application cleanup停止時の最終防衛であり、D1 cleanup完了の根拠にはしない。監査期限は
ユーザー削除と同じ物理削除pipelineへ収束する。詳細は
[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)を参照する。

## PWAと端末上のデータ

service workerがinterceptできるのはsame-originのGETかつ、build済み`/assets/`または
review済みpublic static pathだけである。`/api/*`、artifact path、cross-origin、
non-GETはinterceptしない。navigationはnetwork-onlyで、失敗時だけ本文を持たない固定
offline pageを返す。cache前にresponseがsame-origin、非redirect、`basic`、成功応答で
あることを再検証し、Access login responseを保存しない。

IndexedDBは中断uploadを利用者に案内する最小metadataだけを保持し、CSRF、credential、
署名URL、音声、文字起こし本文を保存しない。job削除時は対応するcheckpointも削除する。

## 障害回復と観測

- Queue、upload-complete、claim、finalize、notification、cancel、delete、retentionは
  複数回実行されても安全にする。
- 外部APIはtimeout、応答schema、retryable/permanent/conflict/cancelledを分類する。
- Cronは期限切れupload、結果不明submission、terminal result、outbox、削除、retentionを
  収束させる。RunPod result保持期限内にterminal状態を観測できない場合はfail closedにする。
- logはallowlist event/fieldだけをJSON出力し、raw exception、URL query、本文、メール、
  object key/prefixを含めない。
- DLQ、replay、alert、手動回復は[operations.md](./operations.md)、secretとdeploy順序は
  [deployment.md](./deployment.md)を参照する。

## Provider migration design（Cloud Run隔離probe成功、未採用）

RunPod supportは、全compatible GPU、全available region、全fallbackにcapacityがない場合も、
公開APIがGPU capacity待ちとその他の`IN_QUEUE`を区別しないことを確認した。この制約と実Workerの
事前attestation、authoritativeなresource lifecycleを解決するため、
[ADR 0066](./adr/0066-design-ephemeral-gpu-vm-execution.md)と
[一時GPU Pod実行設計](./ephemeral-gpu-vm-design.md)でprovider-neutralなinvariantとRunPod Pods比較案を
準備した。RunPod Pods文書は停止中の代替案であり、Phase 12以降のactive実装仕様ではない。
RunPod Podsにはpublic IP、署名identity、create冪等性、hard lifetimeのmandatory gapが残るため、
[ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)によりRunPod Pods評価を停止し、最初の隔離probeを
Cloud Run GPU Jobへ変更した。現行data flow、staging、productionは変更しない。

最初の[Cloud Run GPU隔離probe](./cloud-run-gpu-probe.md)は合成音声、無権限service account、L4 1台、
task 1、retry 0、10分timeoutだけを使用し、GPU/CUDA/model compatibility、起動、終了、削除、課金停止を
一度のexecutionで確認し、全probe resourceを削除した。R2 capability、録音、product controller、D1
migrationを含めない。技術的Adopt candidateでも自動採用せず、
provider lifecycleを別execution aggregateへ分離する設計、identity、data location、最大入力時間、
staging promotionを別ADRで確定してからproduct実装へ進む。

続く[8時間full-scan benchmark](./cloud-run-eight-hour-benchmark.md)では、L4、4 vCPU、16 GiBのexact 1
executionが42秒でmemory limitにより終了した。したがって、Cloud Runの互換性成功をそのまま最大入力の
実行可能性へ拡張しない。現行workerもsource全体を単一`transcribe`へ渡すため、provider移行前に
bounded-memory分割を設計・検証するか、別ADRで最大入力時間を下げる。memory/CPUだけを増やしたcloud
retryは新しいreview packetなしに行わない。

[ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)では、provider taskを分散せず、1 task内で
single-pass FFmpeg decode、15分core、前後30秒context、1 model instanceを順次処理する方式をProposedと
した。segmentはtimestamp ownershipでmergeしてbounded spoolへ書き、選択されたartifactを1形式ずつ生成・
uploadしてmanifest v2を最後に書く。job optionsはattempt作成時のimmutable execution contractへ固定し、
language、VAD、output formatをworkerが暗黙に上書きしない。詳細は
[bounded-memory transcription design](./bounded-memory-transcription-design.md)を正とする。

Phase 10Aではこのcoreを現行serviceへ接続しないisolated moduleとして実装した。8時間virtual PCMは32 windowを
固定上限内で処理し、Python/TypeScriptのcontract v2は同一fixtureでoptions、capability、manifestを検証する。
manifestはformat集合だけでなくjob、attempt、format拡張子までexact keyを照合する。build済みimageでは
networkなしの`bounded_container_check`を追加する。Cloudで同じcoreを測る候補は
[bounded Cloud Run 8-hour re-probe](./cloud-run-bounded-eight-hour-reprobe.md)に隔離し、現行RunPod経路、D1、R2、
staging、productionは変更しない。

Phase 10Cのnative CUDA/float16 quality gateとPhase 10Dのexact L4 revalidation後、
[ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)でCloud Run Jobsを
synthetic-onlyの`Implementation selected`とした。production providerは未採用で、現行routingはRunPod
Serverlessのままである。

Phase 12の`apps/gpu-controller`はCloudflare Orchestratorから独立したcontrol-plane境界である。外部requestは
environment別HMACとstrict schemaを通り、opaque handle以外のapplication dataやresource specを受けない。
controllerはBinary Authorization default policyを含むfixed L4 policyだけからJobを構築し、Cloud Run Admin APIとdurable
control storeをport化する。Job read-backでdefault policyの欠落、無効化、policy override、breakglassを拒否する。
createはdeterministic Job ID、runはdurable intent後exact 1 send、cancel/deleteはexact refとread-backで収束する。
このPhaseのstoreはrestartを再現するin-memory fakeであり、Firestore adapter、service hosting、IAM、secret、
staging接続はPhase 14まで導入しない。

Phase 13では[Cloud Run one-shot runtime](./cloud-run-one-shot-runtime.md)をlocal実装した。runtimeはGoogle
service identityの検証とcontroller live read-backが成功してもchallengeだけを受け取り、memory-only Ed25519署名を
CAS消費した後に初めてsynthetic source/result capabilityを得る。ack前にsource download、CUDA discovery、model loadを
行わず、bounded contract v2のlanguage、VAD、selected format、manifest v2をそのまま実行する。terminalはsessionを失効し
exact cleanupをscheduleするが、provider absenceとartifact/finalize確認前にproduct `COMPLETED`へ遷移しない。
service identityがExecution UIDを署名しない残余riskはsingle-activeとlive read-backで補償し、host attestationとは扱わない。

Phase 14 local preparationではforward-only D1 runtime schemaとrepositoryを追加した。bootstrap/claim/session eventは
`provider_executions`へ外部キーで結び、source/result ownershipとcontract v2をread時にも完全比較する。terminal payloadは
allowlist counterだけを保存し、event INSERT triggerがsequence更新とrevokeを同じstatementへ閉じ込める。
`/internal/cloud-run/*`はstagingのexact synthetic modeとservice注入が揃うまで404/503で閉じたままである。Phase 14の
staging限定composition rootはD1 store、Google OIDC、controller attestation/cleanup、R2 capability、HMAC/Ed25519を結ぶが、
相異なるcanonical secret、fixed origins、dedicated runtime identityを含む全設定が揃わなければserviceを生成しない。
controllerは共有HMAC contractのlive attestation endpointでstore、Job、Executionを照合し、Orchestrator clientは
HTTPS、bounded response、timeout、response identityとexact cleanup mutationを強制する。productionと通常routeへは未注入であり、
staging shadow modeだけが上記composition rootを使う。Google OAuth JWKSのbounded fetch/cacheとRS256 verifierは数値subject ID、
verified email、issuer/audience/timeを別々に検証する。controllerのFirestore adapterはnamed
database、ADC、transaction callback再実行を前提に、environment singleton、request、executionをstrict schemaで永続化し、
active 1、count/JPY reservation、rate、CAS、cleanup releaseを同一transactionへ閉じる。Firestore resource/TTL policy、
IAM、Secret Manager、image attestation、controller Serviceはstagingのdisabled authorizationでstrict read-backまで完了し、
GPU executionは0のままである。productionとproduct routingは接続しない。controller composition rootはmanifest、authorization、
Firestoreのenvironment/projectを完全照合してstore/provider/HMAC handlerを結び、disabled authorizationをADC/provider call
より前に強制する。Node process境界はallowlist environment parser、bounded ADC/HMAC adapter、固定authorityのHTTP transport、
safe JSON log、graceful shutdownを提供する。controller runtime imageはNode 24.18.0実測済みのimmutable distroless
`linux/amd64` manifest、production dependencyだけ、UID/GID 10001、固定entrypointへ閉じ、local inspect、hardened offline run、
runtime `.js`だけのbundle、toolchain/shell/source/declaration/source map不在検証、CycloneDX SBOM、HIGH/CRITICAL
fail-close scanを通した。stagingではSecret Manager fixed-version binding、image publish/attestation、controller Service
deploymentを完了し、productionでは行わない。Cloud Run Serviceのdeployment planはSingapore/Gen2、immutable image、専用identity、bounded
CPU/memory/concurrency/scaling/timeout、traffic 100%、public HMAC ingress、Binary Authorization default policy、固定secret version、
environment allowlistを表現し、normalized read-backの完全一致だけを受ける。Cloud Run v2 raw responseをstrict parseして収束・ready・
traffic・URIを検証するadapterと、IAM、Singapore Secret Manager fixed version、Binary Authorization default policyのstrict local
observation verifierも追加し、必須observationを同一project/environmentのatomic local evidenceへ束ねる。read-only clientは固定Google
API origin/pathへのGET、`getIamPolicy`、署名を変更しないBinary Authorization validation POSTだけへ閉じ、redirect拒否、10秒/256 KiB上限、同一access token、`x-goog-user-project`、2回のstable snapshotへ閉じ、Secret
Manager payload accessを行わない。実credentialによるstaging live read-backと必要なnon-GPU resource mutationは完了した。詳細は
[staging dark deployment](./cloud-run-staging-dark-deployment.md)を正とする。

release supply chainはADR 0080のproject-singleton Binary Authorization attestor、global Artifact Analysis Note、Singapore
Cloud KMS ECDSA P-256 signing versionへ固定する。publisherとsignerを分離したpure plan、attestor/Note/KMS public key/CRC32C/
resource IAMのstrict double-snapshot read-backをlocal実装した。両candidate digestはgcloud 579のcanonical payload、exact KMS key ID、
各1件のOccurrence、Binary Authorization `VERIFIED`を照合し、validation前後の置換を拒否する。release用WIFはglobal poolと
GitHub provider、canonical audience、immutable repository/owner ID、release branch、workflow dispatch、固定workflowをpure planへ
固定する。publisher/signer service accountにはrepository IDの単一principalだけをimpersonation memberとして許可し、active resource、
exact IAM、相異なるservice-account ID、user-managed key 0をdouble-snapshotで検証する。staging candidateのOccurrence発行と
実credential read-backは完了し、production resourceは未接続である。

controller IAMは[ADR 0078](./adr/0078-split-controller-iam-by-resource-boundary.md)に従い、Cloud Run JobsとFirestoreのcustom roleを分離する。
Cloud Run roleから未使用のJob listとExecution getを除き、Firestore roleはtransactionと固定document CRUDだけにする。project policyの
controller principal binding、database condition、runtime service account `actAs`、Artifact Registry repository readerをresource identityと
custom role raw definitionごと完全照合する。固定endpointのIAM read-only clientはcustom role GET、project/repository/runtime
accountの`getIamPolicy`を2回取得してstable snapshotだけを受ける。staging IAM mutationとlive read-backは完了し、productionでは行わない。

controller Firestore resourceは
[ADR 0079](./adr/0079-fix-controller-firestore-database-and-ttl-policy.md)に従い、environment専用named database、Singapore、Native/
Standard、pessimistic transaction、delete protection、API modeをpure planへ固定する。staging PITRはsynthetic cleanupを優先して無効、
production PITRは有効とする。request/execution collection groupの`ttlExpiresAt`だけをoffset 0かつ`ACTIVE`で受けるstrict raw verifierと
fixed GET clientを追加した。individual fieldに加えて`collectionGroups/-/fields?filter=ttlConfig:*&pageSize=3`のdatabase-wide listを読み、
期待2件以外、重複、paginationを拒否する。2回のreadでlist順序だけをresource nameで正規化し、変化し得るoutput-only
`earliestVersionTime`だけをdatabaseの安定性比較から除外する。他のconfig driftは拒否する。Service/security、IAM、Firestoreのstrict
observationを同じdeployment expectationから導出するatomic evidence verifierへ束ね、
別project/databaseのraw observationや未知sectionの混在を拒否する。deployment-level read-only clientは各個別clientと同じpure endpoint
builderを共有し、全resourceを一つのaccess token/quota projectと一つのdouble-snapshot windowで並列取得してからatomic verifierへ渡す。
database/TTL作成、実credential read-back、mutationは行わない。

Phase 11では[ADR 0074](./adr/0074-expand-provider-execution-compatibility-without-mixing-contracts.md)に従い、
provider固有SDK型を含まない`GpuExecutionProvider` port、execution/error/cleanup状態機械、attemptと1対1の
`provider_executions` aggregateを追加する。現行RunPod列はrollback可能性のため保持し、triggerでaggregateへ
dual-writeする。外部副作用を伴うsubmission、claim、completion、cancel、retention、delete、notificationは、
legacy列とaggregateのprovider identity、状態、create outcome、opaque handle、terminal observationが一致する場合だけ
進める。不一致時はどちらかを推測で正とせずfail closedする。

新しいRunPod attemptはlanguage、VAD、model、selected output formatをimmutable snapshotへ固定する。ただし接続中の
RunPod workerとmanifestはv1であるため、snapshotも明示的なcontract v1とする。offline検証済みv2を同じattemptへ混在
させず、provider固有bootstrapからcompletionまで同時に接続できる後続Phaseの新attemptまで発行を停止する。

採用時のtarget releaseは`0.2.0`とし、現行RunPod修正の`0.1.1`へcode、migration、cloud
resourceを混在させない。
