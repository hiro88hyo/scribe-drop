# ADR 0001: 初期契約境界と attempt 状態

- Status: Accepted; RunPod webhookとWorker outputの決定はADR 0006で一部superseded
- Date: 2026-07-25

## Context

`docs/spec.md` はジョブ状態、最大ファイルサイズ、タイトル長、対応コンテナ候補を定義している。一方、次の境界値と外部契約は実装前に具体化する必要がある。

- 元ファイル名の最大長
- 対応コンテナ候補に対応する MIME type
- `job_attempts.status` の列挙値
- RunPod `/status` と webhook を正規化するときの状態値

RunPod の外部payloadは、保存用のドメイン状態や利用者向けAPIへ直接流用しない。RunPod webhook、`/run` input、claim response、Worker outputに関する後続判断は[ADR 0006](./0006-minimal-runpod-capability-exchange.md)を正とする。

## Decision

- 元ファイル名は1～255文字とする。オブジェクトキーには利用せず、D1だけに保存する。
- 初期MIME allowlistは `audio/flac`、`audio/mp4`、`audio/mpeg`、`audio/ogg`、`audio/opus`、`audio/wav`、`audio/webm`、`audio/x-wav`、`video/mp4`、`video/quicktime`、`video/webm` とする。最終的な受理判断はWorkerのffprobe検証で行う。
- attempt はsource検証後に作成するため、状態は `SUBMISSION_PENDING`、`SUBMITTING`、`RUNNING`、`CANCEL_REQUESTED`、`COMPLETED`、`FAILED`、`CANCELLED` とする。retryは既存attemptを戻さず、新しいgenerationを作成する。
- RunPod状態は公式APIで確認できる `IN_QUEUE`、`IN_PROGRESS`、`COMPLETED`、`FAILED`、`CANCELLED`、`TIMED_OUT` を外部契約として検証し、その後に内部状態へ変換する。
- Zod objectは未知フィールドを拒否する。RunPodの仕様追加は暗黙に保持せず、契約とfixtureを明示的に更新する。
- 当初、RunPodへ返すWorker outputはjob ID、attempt ID、manifest keyなどの完了メタデータだけとした。このfield集合はADR 0006でsupersededされ、現在はjob/attempt ID、allowlist済みstatusと統計値、`manifestWritten`だけを返す。文字起こし本文や署名付きURLを含めない原則は維持する。

参照:

- [RunPod: Send API requests](https://docs.runpod.io/serverless/endpoints/send-requests)
- [RunPod: Operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference)

## Consequences

- API入口ではMIMEとサイズを早期拒否できるが、MIMEだけを安全性の根拠にはしない。
- `FAILED` jobはretry可能だが、`FAILED` attemptは終端となる。
- RunPod APIの変更はschema validationで検出されるため、外部payload変更時には契約更新が必要になる。
- filename上限やMIME allowlistを変更するときは、Web表示、APIテスト、Worker検証も同じ変更で更新する。
