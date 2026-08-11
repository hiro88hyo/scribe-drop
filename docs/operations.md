# Operations

## 現在の適用範囲

Phase 3ではR2 Event NotificationのQueue consumerとDLQ routingを実装し、stagingの
D1、R2、Queue、DLQ、Event Notification、OrchestratorとAccess保護済みWebのdeployまで
実施し、欠落R2 sourceのretryからDLQへの到達と限定ackもsmoke testで確認した。
Phase 4ではstaging RunPod endpointを作成し、初回workerのRTX 4090配置、Secure Cloud、
Ready、期限切れclaim拒否を確認した。Phase 5では5分Cronによるsubmission回収、
status poll、finalize、cancelとnotification outboxを実装し、stagingの実browser smokeで
RunPod terminal、manifest、Markdown・JSON・SRT、job完了とDiscord受信まで確認した。
この単一GPU確認は過去checkpointであり、現行releaseのcapacity運用は
[ADR 0049](./adr/0049-pin-observed-runpod-capacity.md)を正とする。
Phase 7では認証済みPWA offline fallback、明示削除、capability安全期限までの延期、
source・result・監査情報の独立retention、次回Cronでの物理削除を固定dummy dataだけで
staging確認し、試験dataをD1/R2から全件清掃した。
初回production試験deployは実施したが、同一candidateのstaging acceptanceを欠き、
実M4Aが`INVALID_MEDIA`で失敗したためrelease evidenceとして無効化した。追加deployは
ADR 0023のpromotion gateで停止している。この文書の手順はstaging/production運用の必須
runbookであり、placeholder IDのままremote操作してはならない。

RunPodが`INVALID_MEDIA`を返した場合、利用者dataを外部toolへ送らない。固定imageと同じ
FFmpeg packageでcontainer、codec、duration、top-level JSON fieldを再現する。
[ADR 0017](./adr/0017-validate-pinned-ffprobe-output.md)に従い、空の`programs`だけを明示的に
受理し、未知fieldや非空programを許可するために`extra="forbid"`を緩めない。

RunPod image revisionまたはprivate registry credentialを切り替える場合、実jobの投入前に
workerが追跡外plan/stateと同じtemplate、image、registry credentialを使っていることを
確認する。endpoint切替後も`EXITED` workerが旧imageを処理し得るため、
[ADR 0047](./adr/0047-drain-stale-runpod-workers-before-promotion.md)のpromotionは
worker上限を0にして全recordをdrainし、template切替後に上限を復旧する。Consoleでの
手動terminateを通常手順にせず、復旧後の全workerについてtemplateとimageを照合する。

`runpodctl serverless get --include-workers`はConsoleに実workerがない場合でも終了済み
recordを返すことがある。`desiredStatus`が`EXITED`または`TERMINATED`ならactiveではないが、
candidateとのtemplate/image不一致を許可しない。`RUNNING`、未知値、欠落値はdrain前に
promotionを停止し、配列の長さやterminal statusだけで安全と判断しない。

実staging lifecycle後のworker証跡では、promotion前のidle-only判定を使わない。
[ADR 0055](./adr/0055-separate-worker-evidence-from-idle-promotion-preflight.md)の専用
read-only verifierだけが、candidateと一致する最大1件の`RUNNING` Workerを許可する。
未知status、candidateと異なるtemplate/image、複数の`RUNNING`、capacity driftは停止条件で
ある。この検査はWorkerをterminateせず、成功・失敗にかかわらず後続の`always()` cleanupで
`workersMin=0`を確認する。cleanup失敗時はacceptanceを発行せず、課金継続として扱う。

staging smokeのためにactive workerを1へ上げた場合、完了後は0へ戻す。固定
`runpodctl` 2.7.2は`--workers-min 0`を成功扱いにしても値を更新しないため、
[ADR 0012](./adr/0012-runpodctl-staging-verification-boundary.md)のdashboard補償を使う。
Consoleでendpointを保存するとtemplateのregistry credentialが以前の値へ戻る場合が
あるため、追跡外planのcredential IDをCLIで再適用し、標準deploy verifierを最後に通す。

Queue、DLQ、D1、R2はenvironmentごとに分離する。操作前にGit branch、Wranglerの
versionと認証先、Cloudflare account、environment、queue名を声出し確認する。
使用tokenの役割と全permissionは
[cloudflare-permissions.md](./cloudflare-permissions.md)を先に確認し、read-only確認の
途中で権限を追加しない。
Worker custom domainを含むdeployでは、固定WranglerがWorker upload後にzoneと既存routeを
read-backする。`pnpm cloudflare:worker-route:verify:<environment>`が成功するまでD1、R2、
RunPod、Worker、Pagesを変更しない。以前成功したtokenを置換する場合は、成功時の8権限と
Account/Zone scopeからの差分を先に確認し、未記録のdashboard構成を棄却しない。

```bash
pnpm exec wrangler --version
pnpm exec wrangler whoami
pnpm exec wrangler queues info recording-uploaded-staging
pnpm exec wrangler queues info recording-uploaded-dlq-staging
pnpm exec wrangler queues consumer list recording-uploaded-staging
```

上記は状態確認だけに使う。resource作成、consumer変更、pause、resume、purge、deployは
変更操作であり、対象と影響を確認した別手順で行う。

## Queueの判定

consumerはbatch全体ではなくmessageごとに次を決める。

- strict schema、account、bucket、生成規則、D1 sourceが不一致のmessageは恒久拒否として
  ackする。raw body、object key、ETagはlogへ出さない。
- sourceのサイズ不一致や不許可actionは、可能な場合にjobへ安全なerror codeと
  `source_rejected` eventを残してackする。
- 同じeventの再配信、既に作成済みのgeneration 1、stale event、処理対象外になった
  terminal jobは冪等なno-opとしてackする。
- R2 HEAD不存在、一時的なR2/D1障害、解消可能なversion競合は指数backoffとjitterを
  指定してretryする。
- 確定済みETagと現在のR2 HEADが異なる場合は`SOURCE_MUTATED`へ遷移し、処理を進めない。
  active attemptがある場合は同じD1 batchでattemptを`FAILED`にし、heartbeatを失効させ、
  jobごとに一件の`source_mutated`監査eventを残す。

`apps/orchestrator/wrangler.toml`はretry上限を5、既定retry delayを60秒にし、上限到達後は
environment別DLQへ送る。Cloudflareの
[DLQ仕様](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)では、
consumerのないDLQ messageは4日間だけ保持されるため、DLQ検知から24時間以内、遅くとも
4日未満にtriageする。

## DLQ triage

DLQには常設push consumerを付けない。障害messageを自動ackまたは無条件にmain Queueへ
戻すと、原因未修正のloopや別environmentへの誤処理を起こすためである。

1. main Queueのconsumer error率、DLQ件数、D1/R2障害情報を確認する。
2. Cloudflare dashboardのmessage previewを使い、messageをackせずに形式だけ確認する。
   preview内容をticket、chat、CI artifactへコピーしない。
3. allowlist logの`jobId`とevent名だけでD1状態を照合する。owner email、source key、
   ETag、録音内容、raw exceptionは調査記録へ残さない。
4. configuration不一致、R2一時障害、D1競合、code defect、既にterminalとなった遅延event
   のどれかに分類する。
5. code/configuration defectは先に修正し、通常のCIとstaging smoke testを通す。
6. D1のcurrent status、active attempt、generation、versionとR2 HEADを再確認し、
   同じmessageの再処理が安全であることを確認する。
7. 承認済みmessageだけをmain Queueへ一度再発行する。main consumerが期待する状態へ
   遷移したことを確認してから、元DLQ messageをackする。

固定Wrangler 4.114.0には個別messageのpreview、replay、ack commandがない。CLIはQueueと
consumerのread-only確認に使い、個別message操作だけCloudflare dashboardで行う。
strict-invalid、別environment、terminal job、stale ETag/generationはreplayしない。
jobが安全なterminal状態で追加遷移不要と確認できた場合だけ、その一件を恒久失敗として
ackする。`SOURCE_MUTATED`はjob、active attemptの`FAILED`、`source_mutated` eventの
三つが一致することを確認する。active jobの整合性を証明できないmessageはackしない。

Cloudflare dashboardのpreviewはmessage位置を変えないが、ackは永久削除になる。
`wrangler queues purge`はQueue全体を削除対象にする破壊的操作なので、このrunbookでは
使用しない。恒久失敗jobの手動SQL更新、raw bodyの一括download、未検証messageの
bulk replayも行わない。必要になった場合は、監査eventとCASを備えた専用repair commandを
先に実装し、別レビューを通す。

## 監視するevent

application logはallowlistされた構造化eventだけを出す。最低限、次を集計する。

- `upload_event_ingested`
- `upload_event_duplicate`
- `upload_event_ignored`
- `upload_event_stale`
- `upload_event_source_mutated`
- `upload_event_source_rejected`
- `upload_event_state_conflict`
- `upload_event_source_unavailable`
- `upload_event_dependency_failure`
- `upload_event_configuration_invalid`
- `reconciliation.completed`
- `reconciliation.configuration_invalid`
- `reconciliation.dependency_failure`
- `reconciliation.state_conflict`
- `job.submission_expired`
- `job.submission_unknown`
- `job.completion_deferred`
- `job.completed`
- `job.failed`
- `job.cancelled`
- `job.deletion_deferred`
- `job.deletion_retry`
- `job.deletion_completed`
- `job.source_retention_completed`
- `job.result_retention_completed`
- `job.audit_retention_scheduled`
- `retention.configuration_invalid`
- `retention.retry`
- `runpod_status_unavailable`
- `runpod_status_invalid`
- `runpod_terminal_observed`
- `runpod_heartbeat_stale`
- `upload_expired`
- `notification.configuration_invalid`
- `notification.sent`
- `notification.deferred`
- `notification.rejected`

`dependency_failure`、`configuration_invalid`、DLQ増加はalert対象とする。
`source_mutated`と`source_rejected`はjob単位のsecurity/quality signalとして追跡するが、
logや通知へobject key、ETag、token、URL queryを追加しない。
`reconciliation.dependency_failure`、`runpod_status_unavailable`の継続、
`notification.rejected`もalert対象とする。Discord障害はjobの`COMPLETED`を取り消さない。
未送信outboxはD1のstatus、attempt数、次回実行時刻だけをread-onlyで確認し、Webhook URLや
本文を調査記録へ出さない。
`job.submission_unknown`の`errorCode`は`RUNPOD_REQUEST_FAILED`、
`RUNPOD_RESPONSE_INVALID`、`RUNPOD_PERSISTENCE_CONFLICT`だけを使用する。RunPodの応答本文、
header、API keyを追加で記録しない。RunPod JSON control APIへのsubrequestは
`Accept-Encoding: gzip`を固定し、Workers runtimeが対応するencoding以外の圧縮済み
passthrough bodyをapplication codeで解釈しない。公開APIへのroutingは
[ADR 0016](./adr/0016-use-manual-redirects-in-workers.md)に従い、`manual` redirect
modeで自動追従を拒否する。3xx responseはprovider failureとして扱い、`Location`や
response bodyをlogへ追加しない。

`job.deletion_retry`の継続または増加もalert対象とする。`errorCode`は
`RUNPOD_CANCEL_FAILED`、`R2_DELETE_FAILED`、`D1_DELETE_FAILED`のいずれかだけであり、
object key、prefix、利用者metadata、raw exceptionを追加しない。
`retention.configuration_invalid`はdeploy停止条件、`retention.retry`の継続はalert対象と
する。retention logにもobject key、prefix、title、filename、本文を追加しない。

## Reconciliationと手動回復

scheduled handlerは5分間隔で起動し、期限切れupload、結果不明submission、RunPod
terminal status、artifact、cancel request、notification outboxを同じservice境界で
回収する。Cronが重複しても期待status、active attempt、generation、winner、versionを
含むCASで一度だけ状態を進める。

通知dispatcherは送信前に、削除されていない`COMPLETED`または`FAILED`で
`notified_at IS NULL`のjobを1件だけoutboxへ登録する。失敗通知は内部例外、error message、
provider応答、録音・文字起こし本文を含めず、title、安全な再実行案内、Access保護済み
詳細リンクだけを送る。失敗通知済みjobをretryすると`notified_at`を消去し、次のterminal
状態で既存outbox行を再初期化する。outboxの`job_version`と現在のjob CAS versionが
異なる場合は、旧通知が`PENDING`または`SENDING`でもattempt数、backoff、errorを次の
通知へ引き継がない。通知は最大で次の5分Cron境界まで遅延し得る。
未送信通知を手動SQLで作成したり、Discord障害を理由にjob状態を戻したりしない。

formal stagingでは[ADR 0059](./adr/0059-require-real-staging-failure-notification-acceptance.md)
の合成破損M4Aを通常経路へ1件だけ投入する。exact `FAILED`、現在versionのoutbox `SENT`、
job/outbox送信時刻を固定Wranglerのread-only remote D1 queryで確認する。job IDを
consoleやartifactへ出さず、mode `0600`のrunner一時fileだけでE2E、検証、明示削除の間を
受け渡す。D1 read-backは`--command --json`だけを使い、進捗行とquery結果を混在させる
ingestion用`--file`を使用しない。正常job前は通常のqueue/in-progress/running 0とidle/ready
candidate Worker、または[ADR 0062](./adr/0062-require-stable-candidate-evidence-for-stale-running.md)の
3回安定したstale `running=1`を確認する。後者の次に
投入できるのは合成fixtureだけである。失敗job前は[ADR 0061](./adr/0061-bind-post-refresh-prewarm-to-worker-restart-evidence.md)に従い、
runner一時evidenceから同じWorker IDでのprocess再起動を確認する。job 0、candidate完全一致、異常state 0が
揃い、同じID/起動時刻を3回連続観測した場合だけstale `running=1`を許容する。検証失敗時も
fixture削除と`workersMin=0`復元を`always()`で行う。本番でこのfailure fixtureや手動SQLを
使わない。job完了後はhandler outputの停止要求とSDK起動設定の両方でWorkerをrefreshし、
旧Workerが残る場合は次fixtureを投入せずscale-to-zeroへ戻す。

10分開始SLOはsubmissionをstaleと判定する境界であり、provider cancel完了時刻ではない。
実際のFAILED遷移とcancel開始は次の5分Cron境界になり得る。利用者表示、alert、staging
timeoutでは「10分ちょうどでprovider queueから消える」と扱わない。

- `SUBMITTING`でprovider応答が不明なattemptは、`submission_outcome`が`unknown`または
  D1書込み失敗で未記録の`NULL`であり、claim期限切れ、winnerなし、
  submission記録なしを同時に満たす場合だけ`FAILED`へ収束させる。同じattemptを
  `/run`へ再送しない。
- `accepted`のまま10分以内にwinner claimへ進まないattemptは、active attemptと
  winner不在をCASで確認して`FAILED`へ収束させる。記録済みのexact RunPod job IDを
  cancelし、成功またはnot-foundをterminal観測として保存する。cancelが不確定なら
  `job.submission_cancel_deferred`を記録し、FAILEDを戻さず次回Cronで再試行する。
- `job.submission_start_slo_exceeded`はGPU供給またはendpoint構成のrelease blockerである。
  claim tokenを15分より延長したり、workflowを自動retryしたりして回避しない。
- RunPod supportは2026-08-10までに、Schedulerが全compatible GPU、全available region、全fallbackを
  評価してcapacityがない場合も、公開APIはGPU capacity待ちとその他の`IN_QUEUE`を区別しないと
  確認した。`IN_QUEUE`、active Worker 0、全worker counter 0は「配置処理なし」を証明せず、
  capacity不足をmachine-readableにも確定できない。Consoleのsupply警告を自動判定へ使わず、
  10分開始SLOでfail closedする。Worker未作成時はWorker logが存在しないため、support調査には
  D1に保持するexact provider job IDとUTC windowを使い、IDをapplication logやtracked文書へ複製しない。
- 同eventはproductionでも利用者影響として扱う。RunPod `/health`の`inQueue`または
  `throttled`増加と、`ready=0`かつ`running=0`を照合する。endpointのGPU候補とtemplateを
  公式APIでread-backし、固定planと不一致なら新規submissionを増やさない。
- claimはjob statusのworker IDとPod詳細を使い、endpoint、RUNNING、candidate image、
  許可GPU、Secure Cloudをwinner CAS前に照合する。照合不能または不一致は通常の
  `CLAIM_REJECTED`としてfail closedにし、R2 URLを発行しない。provider body、worker ID、
  Pod IDをlogへ追加して調査しない。RunPod planとCloudflare bindingのread-backを先に確認する。
- inventory preflightは固定GPU候補がすべてSecure Cloudで提供され、2候補以上が
  availableであることを確認する。stock tierは運用シグナルでありreleaseの合否には使わない。
  live OpenAPIのendpoint create/update enumと認証済みGraphQLの`serverlessGpuPools`にも
  全候補が存在し、各候補が相異なるpoolへ一意に対応しなければならない。条件を
  満たさない場合はworkflowを開始せず、同じjobやworkflowを繰り返して供給待ちを隠さない。
- inventoryのavailableは実割り当てを保証しない。staging acceptanceは
  [ADR 0051](./adr/0051-prewarm-staging-before-job-creation.md)に従い、job作成前に
  candidate Workerを最大8分prewarmする。ready evidenceを得られなければjobを作らず、
  `workersMin=0`のexact read-backまで確認する。cleanup失敗は課金継続のalert対象とする。
- [ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)に従い、追跡対象planは
  `Any Region`とCompliance `Any`を使用する。Compliance filterはSecure Cloud切替ではないため、
  実Workerの`secureCloud=true` attestationを必ず維持する。追跡対象plan
  とpromotionはRESTのGPU情報とConsole-equivalent GraphQLのdata center/compliance情報を
  結合検証し、read-back不能またはdrift時はmutation前に停止する。recovery endpointは
  canonical化し、Cloudflare runtimeとGitHub staging Environmentを同じIDへ同期済みである。
  既存remote endpointは明示承認付きstaging移行まで旧2 data centerを維持し、通常releaseで
  暗黙に変更しない。
- productionは
  [ADR 0056](./adr/0056-require-production-capacity-before-promotion.md)に従い、promotion前に
  GPU順序、data center集合、complianceを固定planへ完全一致させる。production preflightの
  `capacity update pending`は許可しない。事前capacity移行はactive jobと
  running/initializing Workerが0、rollback用の旧capacityが取得済み、固定GPUがavailableで
  ある場合だけ明示承認後に行う。idle/ready Workerは上限0へdrainできるが、capacity
  mutation前にhealth上も0へ収束する必要がある。
  [ADR 0057](./adr/0057-split-runpod-capacity-mutations.md)に従い、GraphQLのdata center更新と
  RESTのGPU更新を各1回だけ送信する。旧GPU保持の中間read-backと最終完全一致をそれぞれ
  最大30秒で確認し、成立しなければ旧data centerと旧GPUへ戻す。
  事前移行またはrollbackが未確認の状態でpromotion workflowを起動しない。
  全local gateとread-only確認後、明示承認を得た場合だけ次を1回実行する。

  ```bash
  pnpm run runpod:capacity:prepare:production -- --confirm-production-capacity-migration
  ```

  commandはGitHub Actions内の実行を拒否し、追跡外production planを使用する。成功表示だけを
  根拠にせず、続けて通常のproduction preflightでcapacity完全一致、active job/Worker 0、
  scale-to-zeroを独立read-backする。capacity更新とrollbackがともに失敗した場合は
  Worker上限0を維持するため、復旧確認なしに上限を戻したりworkflowを起動したりしない。
  endpoint APIに`EXITED`または`TERMINATED` Worker履歴が残っても、それだけをactiveとは
  判定しない。一方、drain後もhealthのidle/initializing/ready/runningが最大30秒で0へ
  収束しなければcapacityを変更せず、Worker上限を復元して停止する。
  drain中に新しいjobがqueueへ入った場合は旧capacityへ戻してからWorker上限を復元し、
  そのjobが新旧capacityの狭間で起動しないようにする。

- 全候補が一時的に不足しても、利用者画面は`SUBMITTING`を「GPU起動中」と表示し、開始SLO
  超過後は`FAILED`と手動retryを提供する。同じattemptの自動再投入やclaim TTL延長はしない。
- 利用者のretryは`FAILED` jobに新しいgeneration、attempt、token、result prefixを作る。
  RunPod Consoleのprovider-side retryは使わない。
- cancelはWeb APIが`CANCEL_REQUESTED`を記録し、Cronがwinnerを再確認してRunPod
  `/cancel`を呼ぶ。RunPod API keyをWebへ複製しない。
- deleteはWeb APIがowner条件とversion CASで即時に論理削除し、heartbeatを失効させる。
  Cronは`deletion_not_before`の前後にかかわらず既知RunPod jobを先にcancelする。cancelが
  acceptedまたはnot-foundでなければD1を保持してbackoffする。最後のR2 capabilityの2時間と
  5分graceが過ぎるまでsourceやresultを消さない。期限後はD1由来のexact source keyと
  全attempt prefixを繰り返しlist/deleteし、R2不存在を確認してからD1親rowを物理削除する。
- retentionはterminal jobだけを対象に、source、attempt result、監査情報を7日、90日、
  180日の独立したcutoffで回収する。値はenvironment変数で変更できるが、
  `source <= result <= audit`を崩さない。監査期限はuser deletionと同じ物理削除へ渡す。
- Phase 11 migration後は、RunPod旧列と`provider_executions`のprovider kind/policy、状態、create outcome、
  opaque handle、terminal observationが一致しないattemptへsubmission、status/cancel、R2 cleanup、notificationを
  実行しない。どちらかを手動SQLで合わせたり、aggregateだけを削除してlegacy扱いへ戻したりしない。まずread-onlyで
  attempt ID、両status、両outcome、handleの一致有無だけを確認し、値そのものをincident logへ残さない。repairが必要なら
  dry-run、CAS、監査eventを持つ専用commandを別変更で実装する。
- cleanupの`PENDING`、`IN_PROGRESS`、`SUCCEEDED`、`FAILED`はexecution statusと別の状態機械である。stale versionや
  concurrent claimがfalseを返すのは正常な競合であり、手動でversionを増減しない。`FAILED`からの再要求だけを許可する。
- Phase 13のCloud Run one-shotはlocal implementationだけであり、運用対象resourceは存在しない。local evidenceは
  `pnpm container:check:cloud-run`、`container:sbom:cloud-run`、`container:scan:cloud-run`で再生成する。SBOMを
  repositoryへ追加せず、local imageをregistryへpushしない。terminal reportはcleanup pendingであり、provider
  Execution/Job不存在とartifact/finalizeを確認するまで手動で`COMPLETED`へ変更しない。
- Phase 14 local preparationで`0011` migrationとshadow namespaceを追加したが、remote D1へ未適用で運用対象ではない。
  `CLOUD_RUN_RUNTIME_MODE`をWrangler、dashboard、secretへ手動設定しない。local D1 eventのsequenceやrevokeを直接更新せず、
  repository経由のexact replayだけを使う。実staging運用は[dark deployment](./cloud-run-staging-dark-deployment.md)の残gateを
  同一candidateで満たしてから別途開始する。
- terminal statusをD1で観測していないjobは、manifestが存在しても`COMPLETED`にしない。
- 手動修復が必要でもjob/attempt/outboxを直接SQLで更新しない。同じrepositoryとserviceを
  使う専用repair commandを先に実装し、dry-run、CAS、監査eventを必須とする。

障害ごとの自動回復、利用者retry、DLQ判断は
[Phase 6 failure injection](./failure-injection.md)の回復区分を正とする。

## User deletionの回復

削除request成功後にjobが画面から消えていても、`deletion_not_before`までは正常な待機で
ある。直ちにR2を手動削除したり、D1親rowを直接消したりしない。

1. allowlist logの`job.deletion_deferred`、`job.deletion_retry`、
   `job.deletion_completed`だけで進行を確認する。
2. retryが継続する場合はerror codeからRunPod control、R2、D1のどこかを特定する。
   URL、object key、title、filename、email、本文をincident記録へコピーしない。
3. `deletion_next_attempt_at`、`deletion_not_before`、attempt count、versionだけを
   read-onlyで確認する。安全期限前のR2不存在を成功条件にしない。
4. dependencyを復旧し、次回Cronの冪等再実行を待つ。手動SQL更新やbucket-wide deleteを
   行わない。
5. `job.deletion_completed`後にD1親子rowがなく、対象exact key/prefixがなく、
   unrelated objectが残ることを固定dummy dataだけで確認する。

D1親rowが残っている限り、provider job IDを失うRunPod queue全体の手動purgeは行わない。
過去の不具合ですでにD1だけが消えた孤児jobを回収する場合に限り、対象environmentで
`inQueue=1`、`inProgress=0`、active worker 0、active D1 job 0をread-onlyで確認し、
別reviewを経た一回限りの回復操作として扱う。通常運用や再試行手順には含めない。

R2 lifecycleはapplication cleanupが長期間失敗した場合の最終防衛であり、利用者deleteの
完了判定には使わない。incomplete multipartはWorkers bindingから列挙できないため、
`incoming/`のlifecycle abortが唯一の自動回収経路である。設定照合ではrule ID、enabled、
prefix、Age秒数を確認し、bucket全体のruleを無条件に上書きしない。

staging smokeのobject不存在確認は
[ADR 0021](./adr/0021-verify-r2-cleanup-with-uncached-listing.md)に従う。同一URLを使う
`wrangler r2 object get`はcacheされた削除前bodyを返す可能性があり、
`r2 object delete`の表示だけでも完了判定しない。通常削除はOrchestratorのR2 bindingが
delete後のhead/listを確認する。smokeの最終照合だけ、予約済みdummy prefixに対する
no-cache・一意query付きObject API listingが成功かつ0件であることを確認する。
production objectの手動CLI削除へこの手順を流用しない。
