# ADR 0002: 初期D1スキーマの不足列を補完する

- Status: Accepted; heartbeat発行時点とwebhook tokenの決定はADR 0006で一部superseded
- Date: 2026-07-25

## Context

`docs/spec.md` は論理削除、完了後の音声時間表示、claimとは独立したheartbeat認証を要求している。しかし、提示された初期SQLには次の保存先がない。

- jobsの論理削除日時
- ffprobeで確定した録音時間
- heartbeat tokenのhash

これらを後続実装まで曖昧にすると、最初のmigration適用直後に破壊的なtable再構築が必要になる。

## Decision

- `jobs.deleted_at`をnullable UTC日時として追加する。通常の一覧・詳細queryはこの列がNULLの行だけを対象とする。
- `jobs.duration_seconds`をnullable REALとして追加し、0秒以上8時間以下に制約する。値は信頼済みWorker結果をfinalizeするときだけ保存する。
- `job_attempts.heartbeat_token_hash`をNOT NULLで追加する。claimとheartbeatは異なるtokenを発行し、D1には小文字hexのSHA-256 hashだけを保存する。
- [ADR 0006](./0006-minimal-runpod-capability-exchange.md)により、heartbeat tokenはwinner claim時に初めて保存できるnullable列へforward-only migrationし、当初追加したwebhook tokenは使用せず除去する。
- `jobs.active_attempt_id`には外部キーを設定する。さらにtriggerで、そのattemptが同じjobに属することを検証する。
- job、attempt、submission source、boolean、世代、サイズ、JSONには可能な範囲でSQLiteのCHECK制約を設定する。
- migrationはforward-onlyとし、適用済みファイルは変更しない。

## Consequences

- 論理削除後も監査・非同期R2 cleanupに必要な行を保持できる。
- UIと通知はmanifestを毎回取得せず、検証済みの録音時間をD1から表示できる。
- heartbeat tokenの漏えい範囲がclaimへ広がらない。
- active attemptの不整合はrepository実装だけでなくDBでも拒否される。
- tokenを追加する実装ではclaimとheartbeatのtoken原文を必要な境界で一度だけ発行し、ログやD1へ保存しない必要がある。
