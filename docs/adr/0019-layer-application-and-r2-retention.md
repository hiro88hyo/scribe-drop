# ADR 0019: application cleanupとR2 lifecycleを重ねて保持期限を実装する

- Status: Accepted
- Date: 2026-07-26

## Context

ScribeDropは未完了multipartを24時間、元録音を7日、文字起こし結果を90日、job監査情報を
180日保持する。値はenvironmentごとに変更でき、元録音の削除後も結果を独立して保持する
必要がある。利用者deleteはこの期限より優先する。

WorkersのR2 bindingはobjectのexact deleteとprefix list/deleteを実行できるが、未完了
multipart uploadを列挙できない。一方、R2 lifecycleはincomplete multipart abortと
prefix別object expirationを実行できるが、D1のartifact rowや監査dataを同じtransactionで
更新できず、利用者deleteの完了判定にもできない。

R2 lifecycleだけに依存するとD1に期限切れartifact metadataが残る。applicationだけに
依存するとCronやdeploymentの長期障害時に録音・本文が期限を超えて残る。

## Decision

- Orchestratorは`MULTIPART_RETENTION_HOURS`、`SOURCE_RETENTION_DAYS`、
  `RESULT_RETENTION_DAYS`、`AUDIT_RETENTION_DAYS`を起動境界で正の整数として検証する。
  初期値は24時間、7日、90日、180日とし、`source <= result <= audit`を必須にする。
- 5分Cronのapplication cleanupを通常の管理経路とする。
  - terminal jobのsourceはupload日時を基準にexact D1 keyをdeleteし、R2不存在を確認して
    `source_deleted_at`をCAS更新する。
  - terminal attemptのresultは完了・失敗日時を基準にD1のattempt固有prefixを
    繰り返しlist/deleteする。空を確認後、`job_artifacts`を削除し
    `results_deleted_at`を更新する。
  - job作成から監査期限を超えたterminal jobは`job_retention_expired`を記録して論理削除し、
    ADR 0018のcapability失効待ちとR2/D1物理削除へ渡す。
- source retention後は同じ録音を使うretryを拒否する。既存成果物と監査表示はそれぞれの
  期限まで独立して残す。
- R2 lifecycleを最終防衛として同じenvironment値から生成する。
  - `incoming/`: source expirationとincomplete multipart abort
  - `results/`: result expiration
- lifecycle JSONとOrchestrator Wrangler設定は同じrendererで生成する。tracked templateの
  rule ID、prefix、action、初期値がdriftした場合は生成を拒否する。
- lifecycleが先にobjectを削除していてもapplication cleanupは不存在を成功としてD1を
  収束させる。application cleanupのR2一時障害は次回Cronで冪等に再試行する。
- user deleteは保持期限を待たずADR 0018の経路を優先する。retention cleanupは
  `deleted_at IS NULL`だけを対象にし、user deletionと競合したCASはno-opにする。

## Consequences

- sourceとresultは別prefix・別D1 markerで期限管理されるため、録音だけを先に削除できる。
- lifecycle実行とCronには遅延があるため、保持期限は「期限到達後に非同期削除を開始する」
  境界であり、秒単位の削除時刻保証ではない。
- incomplete multipartはR2 lifecycleが唯一の自動cleanup経路である。deploy前に生成JSONを
  適用・read-only照合し、未設定をapplication成功で代替しない。
- lifecycleがobjectを先に消す短い期間、D1にartifact metadataが残りdownloadが失敗する
  可能性がある。次回Cronがmetadataを削除して収束する。
- audit期限後は長期tombstoneを残さず、job親子rowを物理削除するため、期限超過件数の
  長期集計はできない。
