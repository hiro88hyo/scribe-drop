# ADR 0058: terminal失敗をoutbox集中走査で通知する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0013

## Context

production smokeでRunPod Workerが開始SLO内に割り当てられず、jobとattemptは安全に
`FAILED`へ収束し、記録済みprovider jobもcancelされた。Web画面は失敗を表示したが、
Discord通知は送られなかった。

従来のnotification outboxは、artifact検証後の`COMPLETED` finalizeと同じD1 batchでだけ
作られ、dispatcherも`COMPLETED`だけを取得していた。失敗はupload、Queue ingestion、
submission回復、開始SLO、RunPod terminal、artifact不備など複数のrepository境界で確定
する。各失敗SQLへ通知作成を追加すると、新しい失敗経路で追加漏れが生じやすく、状態更新と
通知の一貫性も個別に検証し続ける必要がある。

一方、既存schemaは`notification_outbox.job_id`を一意にしている。失敗通知を送ったjobは
新しいgenerationでretryでき、その後に成功通知または再失敗通知が必要になる。失敗行を
単純に追加するだけでは一意制約により次の通知が失われる。

## Decision

- 5分Cronのnotification serviceはclaim前に、削除されておらず、
  `notified_at IS NULL`で、現在状態が`COMPLETED`または`FAILED`のjobを1件だけoutboxへ
  冪等に登録する。
- terminal走査をnotification repositoryへ集約する。各失敗repositoryは通知を直接作らず、
  jobとattemptの正しい状態遷移だけを担当する。
- outboxへ対象jobのCAS `version`を保存する。同じversionの`PENDING`または`SENDING`行が
  あるjobは再登録しない。versionが異なる行、または`SENT`か`DEAD`の行は、attempt数、
  送信時刻、errorを消して`PENDING`へ戻す。前の失敗通知の配送障害を、retry後の成功または
  再失敗通知へ持ち越さない。
- forward-only migration `0009_notification_terminal_generation.sql`でnullableな
  `job_version`を追加し、既存outbox行は参照先jobの現在versionでbackfillする。新規行は
  必ず正のversionを保存し、claimと送信ackでも現在versionとの一致を要求する。
- dispatcherのclaimはD1上の現在状態を再確認し、`COMPLETED`と`FAILED`をdiscriminated
  payloadとして扱う。完了通知だけがdurationと処理時間を必須とし、失敗通知はそれらへ
  依存しない。
- 失敗通知はtitle、安全な再実行案内、Access保護済みjob詳細リンクだけを含む。内部例外、
  provider応答、error message、録音・文字起こし本文、object key、署名付きURLは含めない。
- 送信ackは、claimしたterminal状態とjobの現在状態が一致する場合だけ`notified_at`を更新
  する。Discord障害はjobのterminal状態を変更せず、既存の上限付き指数backoffを使用する。
- cancellationと期限切れuploadは失敗通知の対象に含めない。利用者の明示操作または処理未
  開始の期限切れであり、通常の失敗と区別する。

## Consequences

- 既存および将来の`FAILED`経路を、個別enqueueの追加漏れなく通知できる。
- 1 job 1 outbox行のschemaを維持しながら、失敗、retry、成功または再失敗の順序を扱える。
- terminal遷移と通知登録は同じD1 batchではないため、通知は次の5分Cronまで遅延し得る。
  job状態を正とし、Cronの冪等走査で最終的に回収する。
- 失敗直後に利用者がretryまたはdeleteし、dispatcherがclaimする前にjobがterminalで
  なくなった場合、その古い失敗通知は送らない。現在状態と矛盾する通知を優先しない。
- release candidateのapplication SHAが変わるため、既存のstaging acceptanceとproduction
  promotion evidenceは再利用せず、新candidateから検証し直す。
