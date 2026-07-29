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
- 同eventはproductionでも利用者影響として扱う。RunPod `/health`の`inQueue`または
  `throttled`増加と、`ready=0`かつ`running=0`を照合する。endpointのGPU候補とtemplateを
  公式APIでread-backし、固定planと不一致なら新規submissionを増やさない。
- inventory preflightは固定GPU候補がすべてSecure Cloud専用かつavailableであることを
  確認する。stock tierは運用シグナルでありreleaseの合否には使わない。条件を満たさない
  場合はworkflowを開始せず、同じjobやworkflowを繰り返して供給待ちを隠さない。
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
