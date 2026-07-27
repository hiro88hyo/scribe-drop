# ADR 0018: user deletionはcapability失効後にR2を消してD1を物理削除する

- Status: Accepted
- Date: 2026-07-26

## Context

`DELETE /api/jobs/:id`は利用者からjobを直ちに見えなくした後、元音声、全generationの
artifactとmanifest、D1表示data、browserのIndexedDB metadataを削除する必要がある。
R2とD1に分散した削除は一つのtransactionにできず、Cron重複、R2一時障害、途中停止に
耐える必要がある。

active RunPod Workerへ発行済みのR2 PUT capabilityは2時間有効である。論理削除直後に
artifactを消しても、Workerが処理を続けて同じattempt prefixへ再度PUTすればdataが
復活する。heartbeatを失効させ、既知のRunPod jobをcancelしても、response喪失や停止点までの
遅延があるため、cancel成功だけをR2削除の安全条件にはできない。

結果prefixはgenerationごとに異なり、失敗したattemptにもpartial artifactが残り得る。
検証済み`job_artifacts`だけを削除すると、manifestのないpartial dataを取り残す。

追加要件は監査情報を残す場合のfieldを限定しているが、tombstoneの保持自体は必須ではない。
user deletionでは復元不能性を優先し、長期tombstoneを残す必要性は現時点で確認されていない。

## Decision

- owner条件、Access JWT、CSRF、Origin、JSON content typeを検証した
  `DELETE /api/jobs/:id`を追加し、期待versionを含むD1 batchで`deleted_at`を設定する。
- 論理削除と同じbatchでactive heartbeatを失効させ、active attemptをcancel状態へ進める。
  一覧、詳細、artifact、retry、cancel、Queue、submission、notificationは
  `deleted_at IS NULL`を維持し、削除request成功後はjobを利用者へ返さない。
- deletion cleanupはOrchestratorの5分Cronが担当する。PagesへRunPod API keyやR2の
  広い削除権限を追加しない。
- 既知のRunPod job IDは冪等にcancelする。ただしR2 dataの削除は、最後に発行し得た
  capabilityの2時間に5分のgraceを加えた`deletion_not_before`以降だけ行う。
- sourceはD1に保存したexact keyを削除する。resultはD1に属する全attemptの
  `result_prefix`をpaginationし、各prefixをR2でpaginationしてpartial artifactと
  manifestを含む全objectを削除する。bucket全体のlistや利用者入力prefixは使わない。
- R2 delete後に各prefixとsourceの不存在を確認し、その後だけjob rowをCAS付きで物理削除する。
  foreign key cascadeでattempt、submission、event、artifact、notificationも削除する。
- R2/D1一時障害はbounded exponential backoffで再試行し、任意error textは保存しない。
  `deletion_attempt_count`とallowlist error codeだけを論理削除rowへ保持する。
- 長期deletion tombstoneは作らない。物理削除完了後はjob ID、title、filename、email、
  object key、本文参照をD1へ残さない。
- browserはDELETE成功後、対応するIndexedDB checkpointを冪等に削除する。
- R2 lifecycle ruleはcleanup失敗時の最終防衛とし、user deletionの成功応答や通常の
  cleanup完了判定の代わりにはしない。

## Consequences

- 利用者の画面からはDELETE成功時点で即時に消えるが、R2の物理削除完了まで最大2時間5分と
  次回Cron分の遅延がある。この待機はdata復活を防ぐための上限付き安全境界である。
- cancel APIやheartbeatに到達できないWorkerが既に音声を`/tmp`へ取得している場合、
  container終了まで一時copyが残る可能性はある。heartbeat拒否、RunPod cancel、workerの
  `finally` cleanupとrefreshで影響を抑える。
- prefix list/deleteが途中で失敗しても、次回は同じprefixを再走査するため冪等に回復できる。
- tombstoneを残さないため削除後の長期監査件数は取得できない。法的・運用上の保持義務が
  確認された場合だけ、keyed hash、削除日時、結果、allowlist error code、期限を持つ
  別schemaを新しいADRとmigrationで追加する。
