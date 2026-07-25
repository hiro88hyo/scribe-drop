# ADR 0010: attempt作成とRunPod capability発行を分離する

- Status: Accepted
- Date: 2026-07-25
- Supersedes: ADR 0006のclaim lifecycle migrationをPhase 4開始時に追加する時期だけを変更する

## Context

R2 Event Notification consumerはsource確定時にgeneration 1のattemptを一度だけ作成し、
jobを`SUBMISSION_PENDING`へ遷移させる。一方、追加security要件と
[ADR 0006](./0006-minimal-runpod-capability-exchange.md)では、claim tokenをRunPod投入
直前、heartbeat tokenをwinner claim後に初めて発行する。

適用済みの`0001_initial.sql`では`claim_token_hash`、`heartbeat_token_hash`、
`webhook_token_hash`がNOT NULLであり、tokenが未発行であることを表現できない。
predictableなdummy tokenを有効なtokenとして扱うことや、Queue処理中にraw tokenを
永続化することはできない。

## Decision

- forward-only migration `0003_attempt_capability_lifecycle.sql`で
  `claim_issued_at`、`claim_expires_at`、`claim_consumed_at`、
  `heartbeat_issued_at`をnullable列として追加する。
- Queue consumerはgeneration 1作成時に、attempt IDと用途をdomain separationした
  文字列のSHA-256をlegacy NOT NULL hash列へ保存する。このdigestはtoken原文ではなく、
  capability未発行時のsentinelである。
- 未発行sentinelの入力文字列は秘密にしない。claim APIはhash一致だけで許可せず、
  `claim_issued_at`と`claim_expires_at`が非NULL、未消費、current attempt、
  許可statusであることを必須とする。
- Phase 4のRunPod投入直前に256 bit claim tokenを生成し、hash、issued、expiryを同じ
  条件付き更新で置き換える。raw tokenはその直後の`/run` requestに一度だけ使用する。
- heartbeat hashはwinner claim成功時に生成したtoken hashとissued時刻で置き換える。
- webhookは使用しない。`webhook_token_hash`はPhase 4のtable rebuildまでsentinelの
  ままとし、どの認証経路からも参照しない。
- Queue consumerはattemptを`SUBMISSION_PENDING`まで作成するが、RunPodへは投入しない。
  `SUBMISSION_PENDING`から先のtoken発行と投入はPhase 4の責務とする。

## Consequences

- source ingestionとRunPod投入の間でraw capabilityを保存せず、Phase境界を維持できる。
- sentinel digestは導出可能だが、発行時刻がNULLであるため認証には使用できない。
- Phase 4ではclaim APIを実装する前に、issued、expiry、consumedを含むCASと
  `webhook_token_hash`除去migrationを完成させる必要がある。
- `0001_initial.sql`を変更せず、既存databaseへ追加migrationを適用できる。
