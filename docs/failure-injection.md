# Phase 6 failure injection

## 目的と境界

Phase 6は外部serviceを通常CIから呼ばず、固定clock、固定ID、実migrationを適用した
Miniflare D1/R2、型付きfake transportを使って障害と回復を再現する。fault injectionは
`@scribe-drop/test-support`の`DeterministicFaultPlan`で「境界名」と「何回目に失敗するか」
を宣言する。予定した障害が実際に通らなければ`assertExhausted()`がtestを失敗させる。

同packageの`inspectStructuredLogs`は各recordをJSONとしてparseし、必須envelopeを検証した
うえで、scenario固有のtoken、署名query、object key、ETag、本文fixtureが含まれないことを
自動検査する。Python Workerもstable error codeだけを検査し、URL queryと本文fixtureを
stdout、例外、RunPod outputへ残さない。

fault harnessはtest専用であり、本番codeからimportしない。本番environmentに障害注入用の
変数、endpoint、分岐を追加しない。

## 必須scenarioと証明

| Scenario                   | 決定的な障害                                          | 必須assertion                                                                                                         | 主な自動test                                         |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `/run`成功後のresponse喪失 | provider効果の後で1回目のresponseを失う               | outcomeは`unknown`、同じattemptの再投入は`deferred`、provider効果は1回                                                | `runpod-submission-service.test.ts`                  |
| `/run`成功後のD1失敗       | `recordSubmissionAccepted`の1回目を失敗               | outcome未記録でも同じattemptを再送せず、claim期限後にjob/attemptを`FAILED`へCASし、eventは1件、submission/outboxは0件 | `runpod-control.worker.spec.ts`                      |
| D1 commit後のQueue ack失敗 | 1回目の`ack()`を失敗                                  | retry後の再配信は同じgeneration/attempt/eventを増やさずackされる                                                      | `upload-queue.worker.spec.ts`                        |
| winner/loser逆順           | loser terminalをwinnerより先に保存                    | loserは更新0件、winnerだけがterminal/finalize可能                                                                     | `completion.worker.spec.ts`                          |
| retry後の古いgeneration    | generation 2をactiveにしてgeneration 1 terminalを保存 | active attempt、job、artifact、event、outboxを変更しない                                                              | `completion.worker.spec.ts`                          |
| partial result             | artifact PUT効果後にresponseを失いmanifestを書かない  | partial artifactは完了markerにならず、Cronは保持grace中deferし、その後fail closed                                     | `test_service.py`、`completion.worker.spec.ts`       |
| 二つのCron                 | terminal保存後に二つのreconciliationを並行実行        | job/attempt完了、artifact 3件、event 1件、outbox 1件                                                                  | `completion.worker.spec.ts`                          |
| source上書き               | 確定ETag後、処理前と`RUNNING`中に別ETagを観測         | jobは`SOURCE_MUTATED`、active attemptは`FAILED`、監査eventは1件、outboxは0件                                          | `upload-queue.worker.spec.ts`、`jobs.worker.spec.ts` |

外部境界の個別coverageは次のとおりである。

- R2 HEAD/GETは1回目を失敗させ、後続Cronで同じterminal outcomeを安全に完了させる。
- R2 GET/PUTのtimeoutはRunPod Workerで
  `SOURCE_DOWNLOAD_FAILED`/`ARTIFACT_UPLOAD_FAILED`へ正規化する。
- D1は例外、CAS 0件、並行更新を区別し、期待status、active attempt、generation、versionを
  SQL条件から外さない。
- Queueはmessage単位のack/retryと再配信を検証する。
- RunPodはrequest timeout、invalid response、status重複、404、未知status、result保持期限を
  検証する。
- Discordは429と5xxをoutboxへ戻し、lease期限とbackoff後だけ再取得する。

## 回復区分

| 障害                                       | 回復主体          | 回復条件                                                                                 |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------- |
| R2 HEAD/GET、D1、status、Discordの一時障害 | Queue/Cron/outbox | dependency復旧後に同じCASを再実行する                                                    |
| Queue ack喪失                              | Queue再配信       | 同一eventがduplicate/no-opとしてackされる                                                |
| `/run`結果不明                             | Cron              | claim期限切れ、winnerなし、submissionなしをすべて満たすまで待ち、同じattemptは再送しない |
| partial artifact、manifest欠落             | Cron後に利用者    | result保持grace中はdeferし、期限後`FAILED`。原因修正後は新generationでretryする          |
| source上書き                               | 利用者            | 既存jobは`SOURCE_MUTATED`のまま再利用せず、新しいsource keyを持つjobを作成する           |
| terminal result消失                        | 利用者            | RunPod TTLと保持grace後に`FAILED`へ収束してから新generationでretryする                   |
| DLQ                                        | 運用者            | 下記runbookで一件ずつ原因を除去し、安全なmessageだけを一度replayする                     |

## DLQ確認、replay、恒久失敗

固定Wrangler 4.114.0はQueue情報とconsumer設定を取得できるが、個別messageのpreview、
replay、ackをCLIで提供しない。対象accountとenvironmentを確認したうえで、個別messageの
操作だけCloudflare dashboardを使用する。raw bodyをticket、chat、shell history、
CI artifactへ複製しない。

1. main QueueとDLQの名前、consumer、message件数、発生時刻をread-onlyで確認する。
2. allowlist logのevent名とjob IDだけで、D1のjob、active attempt、generation、version、
   submission、event、outboxを照合する。
3. R2/D1/configuration/code障害なら先に原因を除去し、通常CIとstaging smokeを通す。
4. 同じmessageの再処理がCASまたはduplicate判定で安全と確認できた場合だけ、dashboardで
   main Queueへ一度replayする。
5. main consumerのackと期待状態を確認してから、元DLQ messageだけをackする。

strict-invalid、別environment、既にterminalなjob、stale ETag/generationのmessageは
replayしない。対応するjobが安全なterminal状態であり追加遷移が不要とread-onlyで確認した
場合だけ、そのDLQ messageを恒久失敗としてackする。`SOURCE_MUTATED`ではjob、
active attempt、`source_mutated` eventの組を確認する。

active jobの整合性を証明できないmessage、sourceの存在を確認できないmessage、
原因未修正のmessageはackしない。直接SQL、Queue全体purge、bulk replayで恒久失敗化しない。
専用repair commandが必要な場合はdry-run、CAS、監査event、対象environment確認を実装した
別PRを先にreviewする。consumerのないDLQは保持期限が短いため、24時間以内にtriageし、
保持期限前に解決できない場合はincidentとして扱う。
