# ADR 0086: Cloud Run Jobsをproduction GPU providerとして採用する

- Status: Accepted
- Date: 2026-08-15
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0071、ADR 0076、ADR 0083、ADR 0085

## Context

candidate `b7ae428`はPhase 14とPhase 15で、Cloud Run Jobsのexact-one L4 execution、通常upload、
cancel、worker停止、heartbeat response loss、破損media、capacity rejection、controller outage、
notification retry、artifact download、利用者delete、resource/storage cleanupをstagingで完了した。
data locationはSingapore、task/parallelismは1、retryは0、timeoutは3,300秒、1 executionの
worst-case guardは250 JPYであり、各scenario後にCloud Run Job/Executionとcontroller永続状態を0へ戻した。

一方、同candidateのOrchestratorとproduction設定生成器は、Phase 15前の安全境界としてCloud Runを
`APP_ENV=staging`と`synthetic-shadow`へ意図的に限定している。既存production workflowもRunPod image、
Orchestrator、Pagesだけを昇格し、Cloud Run candidate、controller、Firestore、IAM、secret、provider switchを
扱わない。この状態で旧workflowを実行してもPhase 16にはならない。

Phase 16はPhase 15のexact candidateを入力にすると記載していたが、production採用を決める前にproduction
portを実装しないADR 0071の順序とは両立しなかった。この差異を暗黙の手動deployで回避しない。

## Decision

- Cloud Run Jobs L4を`Production adopted`とする。根拠はcandidate `b7ae428`に結び付いたPhase 14/15 evidenceとする。
- production runtimeは`APP_ENV=production`と`CLOUD_RUN_RUNTIME_MODE=active`の完全一致だけを受ける。
  stagingの`synthetic-shadow`、productionの`active`、disabledを相互に読み替えない。
- production controller Service、controller/runtime service account、Firestore database、HMAC secret、
  authorization documentはproduction専用resourceを使用する。staging名、identity、secretを拒否する。
- `GPU_EXECUTION_POLICY`とruntime/reaperを分離する。初回deployではruntimeを`active`、policyを
  `runpod_serverless_v1`、`GPU_EXECUTION_ADMISSION=paused`とし、新規GPU attemptの受付を止めたまま
  read-backする。既存RunPod attemptが
  terminalまたは安全なpendingへ収束した後、新attemptだけを`cloud_run_jobs_l4_v1`へ切り替える。
  policyをRunPodへ戻しても既存Cloud Run attemptのreconcile、cancel、cleanupは継続する。
- 自動fallbackは実装しない。どちらのproviderにも安全に投入できない場合は`SUBMISSION_PENDING`へ保持する。
- controller/worker imageは同じcommitのCloud Run candidate workflowで各1回だけbuild、push、KMS署名し、
  immutable digestをstaging acceptanceとproduction promotionの両方で照合する。production用に再buildしない。
- production admissionを追加するsource、deployment config、promotion workflowの変更は`b7ae428`のpromotion
  evidenceを失効させる。変更後の単一commitから新candidateを作り、stagingでCloud Run通常lifecycle、
  artifact/notification、cleanup、resource/storage不存在を再確認して新しい期限付きacceptanceを発行する。
  `b7ae428`のfault matrixは採用判断の履歴として保持するが、新candidateの代わりにはしない。
- production promotionは成功した期限内staging acceptanceだけを入力にし、migration、controller、
  paused Orchestrator/Pages、read-back、drain、switchの順序を固定する。promotion workflowは`cutover`と
  `finalize`の2操作に分ける。`cutover`は別途承認されたexact-one L4、250円、2時間以内のauthorizationだけを
  開いて停止し、production Accessにstaging service principalを追加しない。利用者が実画面でupload、artifact、
  notificationを確認した後、`finalize`がそのjob ID、provider resource/storage cleanup、staging parityを検証し、
  admissionを一旦pauseしてから明示された1〜20 execution、execution当たり250円、24時間以内の運用枠へ移す。
- controllerの有限authorizationはadmission paused中だけ変更する。Service設定を先にread-back可能な状態へ更新し、
  Firestore authorizationをCASで更新する。同一・未消費authorizationのretryだけを冪等に許可し、消費済み、
  別epoch、予約済み状態からの上書きを拒否する。
- source-controlled foundationはstaging/productionのworkflow専用WIF providerとdeployer service account、
  production controller/runtime service account、dedicated Firestore、TTL、regional HMAC secret、最小custom role、
  resource別IAMだけを作る。controller Serviceはstaging accepted candidateのproduction `cutover`まで作らない。
  bootstrapは完了時に全resourceとIAMをstrict read-backする。

## Consequences

- Phase 15後にproduction portが必要と判明したため、production cutover前にcandidate buildとbounded staging
  acceptanceを1回追加する。旧candidateや旧production workflowを実行して見かけ上のreleaseを作らない。
- runtime routeとreaperをprovider selectionから独立させるため、rollback時にもCloud Run resourceを安全に
  0へ収束できる。
- production用Google Cloud foundationとGitHub Environment契約が追加される。作成・更新前にaccount、project、
  environment、exact resource planをread-onlyで照合し、明示承認を得る。
