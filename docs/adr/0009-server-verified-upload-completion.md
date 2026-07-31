# ADR 0009: upload完了はserver側R2 HEADで確定する

- Status: Accepted
- Date: 2026-07-25

## Context

browserはmultipart完了時にETagを観測できるが、browserから送られたETag、size、keyを
信頼すると、別objectや改変metadataをjobへ関連付ける余地が生じる。一方、R2 Event
Notificationはat-least-onceであり、browserの補助通知より先にも後にも到着し得る。

`POST /api/jobs/:id/upload-complete`は利用者への早い状態反映には有用だが、Queue eventを
置き換えず、RunPod attemptを作成する責務も持たせない。

## Decision

- request bodyはstrictな空objectだけを受け付ける。ETag、size、bucket、keyをbrowserから
  受け取らない。
- Access JWT、CSRF、Origin、JSON Content-Type、job ID、SQL内の`owner_sub`を検証する。
- D1から所有者付きsource bucket、source key、expected size、versionを取得し、設定済み
  R2 bindingでそのexact keyをHEADする。
- R2 HEADのsizeは申告時のFile sizeと完全一致させる。不一致を許容する変換処理はuploadと
  source確定の間に存在しないため、差分は不正または破損として扱う。
- 初回通知は期待version、source情報、`CREATED`または`UPLOADING`、未確定ETagを条件に
  `UPLOADED`へcompare-and-setする。
- 同じsizeとETagの再送は状態を巻き戻さず成功とする。確定後に異なるETagを観測した場合は、
  許可されたactive状態から`SOURCE_MUTATED`へ遷移し、`SOURCE_ETAG_CHANGED`を記録する。
- R2 HEADの不存在、size不一致、状態競合は安全なmachine-readable errorを返す。R2障害や
  不正なR2応答は内部エラーとしてfail closedにする。
- browserはR2完了後にこのAPIを呼び、API通知だけが失敗した場合は同じjobへの通知だけを
  再試行する。新しいjobやmultipart uploadを自動作成しない。
- attempt generation 1の作成とRunPod投入はR2 Event Notification consumerに限定する。

## Consequences

- browserが偽のETag、size、keyをD1へ保存させることはできない。
- HTTP通知とQueue eventの順序が入れ替わっても、Queue側が同じETagとsizeを冪等に扱える。
- R2 objectがまだ参照可能になる前の通知は`SOURCE_NOT_FOUND`になり、browserから再試行
  できる。
- upload-complete単独では処理開始しないため、Queue consumerとEvent Notificationが
  未実装の間はdeployしない。
