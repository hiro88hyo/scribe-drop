# Operations

## 現在の適用範囲

Phase 3ではR2 Event NotificationのQueue consumerとDLQ routingを実装し、stagingの
D1、R2、Queue、DLQ、Event Notification、OrchestratorとAccess保護済みWebのdeployまで
実施し、欠落R2 sourceのretryからDLQへの到達と限定ackもsmoke testで確認した。
Phase 4ではstaging RunPod endpointを作成し、初回workerのRTX 4090配置、Secure Cloud、
Ready、期限切れclaim拒否を確認した。Phase 5では5分Cronによるsubmission回収、
status poll、finalize、cancelとnotification outboxをlocal実装・検証済みである。
production environmentへのdeploymentは未実施である。この文書の手順は
staging/production運用の必須runbookであり、placeholder IDのままremote操作してはならない。

Queue、DLQ、D1、R2はenvironmentごとに分離する。操作前にGit branch、Wranglerの
versionと認証先、Cloudflare account、environment、queue名を声出し確認する。

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
passthrough bodyをapplication codeで解釈しない。

## Reconciliationと手動回復

scheduled handlerは5分間隔で起動し、期限切れupload、結果不明submission、RunPod
terminal status、artifact、cancel request、notification outboxを同じservice境界で
回収する。Cronが重複しても期待status、active attempt、generation、winner、versionを
含むCASで一度だけ状態を進める。

- `SUBMITTING`でprovider応答が不明なattemptは、claim期限切れ、winnerなし、
  submission記録なしを同時に満たす場合だけ`FAILED`へ収束させる。同じattemptを
  `/run`へ再送しない。
- 利用者のretryは`FAILED` jobに新しいgeneration、attempt、token、result prefixを作る。
  RunPod Consoleのprovider-side retryは使わない。
- cancelはWeb APIが`CANCEL_REQUESTED`を記録し、Cronがwinnerを再確認してRunPod
  `/cancel`を呼ぶ。RunPod API keyをWebへ複製しない。
- terminal statusをD1で観測していないjobは、manifestが存在しても`COMPLETED`にしない。
- 手動修復が必要でもjob/attempt/outboxを直接SQLで更新しない。同じrepositoryとserviceを
  使う専用repair commandを先に実装し、dry-run、CAS、監査eventを必須とする。
