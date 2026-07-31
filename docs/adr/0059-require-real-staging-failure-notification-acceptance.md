# ADR 0059: 実service失敗通知をstaging acceptanceに必須化する

## Context

[ADR 0058](./0058-notify-terminal-failures-through-outbox-sweep.md)で、未通知の
`COMPLETED`と`FAILED`を通知境界で集中走査し、jobのCAS versionごとにoutboxを再利用する
方式を採用した。しかし従来のformal staging acceptanceは成功M4A lifecycleと完了通知だけを
実serviceで確認し、合成失敗からDiscord配送までを通さなくても短命acceptanceを発行できた。
service unit testとMiniflare D1統合testだけでは、実Cron、remote D1、実Webhook secret、
staging Access境界の結合をproduction promotion前に証明できない。

検証のために本番用障害注入endpoint、runtime switch、手動SQLを追加すると、新しい攻撃面、
通常運用との差異、cleanup漏れを作る。実録音や文字起こし本文をfixture、log、artifactへ
残すこともできない。

## Decision

- formal stagingは正常な合成M4Aと合成破損M4Aの各job直前にexact candidate Workerを
  prewarmする。provider queueとin-progress jobが0、running Workerが0、idleまたはready
  Workerが1件以上の場合だけjobを作る。正常jobのWorker refresh後も同じ条件へ戻るまで
  失敗fixtureを投入しない。
- 音声を含まない短い合成破損M4Aを通常のWeb/API/R2/Queue/RunPod経路へ1件だけ投入する。
- failure fixtureはexact `FAILED`へ到達しなければ不合格とする。`COMPLETED`、
  `CANCELLED`、`EXPIRED`、`SOURCE_MUTATED`を失敗通知の代替証跡にしない。
- job IDはGitHub runnerのmode `0600`一時fileだけへ保存する。console、長期artifact、
  staging acceptance、文書へjob ID、URL、録音・文字起こし本文を保存しない。
- 固定Wranglerのremote D1 queryを引数配列で実行し、対象jobが`FAILED`、現在のjob
  versionとoutbox `job_version`が一致、outboxが`SENT`、jobとoutboxの送信時刻が存在する
  場合だけ実配送成功とする。厳格検証済みULIDを固定SQLへ埋め込み、Wranglerの
  `--command --json`へshellを介さない単一引数として渡す。`--file`はD1 ingestion経路と
  進捗出力を使うためread-only queryには使用しない。query結果はallowlist fieldだけを
  parseし、SQLやjob IDをconsoleへ出さない。
- failure fixtureはstaging Access service principalで明示削除する。通知検証やE2Eが失敗
  してもcleanupを`always()`で実行し、その後にRunPod `workersMin=0`とactive Worker 0を
  exact read-backする。
- staging acceptanceをschema version 3、policy `adr-0059-v1`へ更新し、
  `failedEndToEndM4a`、`failureNotificationDelivered`、
  `failureJobCleanupRequested`を必須checkにする。旧acceptanceはproductionへ使用しない。
- 本番環境へ障害注入機能を追加せず、production smokeで失敗を意図的に作らない。

## Consequences

- formal stagingはGPU jobとidle gateが1組増え、Cron境界とDiscord応答を待つため実行時間と
  費用が増える。job全体はcleanup余裕を含む45分だが、二つのprewarmは各8分、失敗jobは
  7分、通知read-backは1分で個別に停止する。
- unit/integration testだけが成功していても、実service失敗通知、fixture削除、
  scale-to-zero復元のいずれかが失敗すればproduction promotionは開始できない。
- failure fixtureの内容は非機密な固定文字列であり、実録音、実文字起こし、利用者dataを
  staging acceptanceへ持ち込まない。
- acceptance policy変更はapplication SHAを変えるため、既存candidateとstaging evidenceを
  再利用せず、新candidateからformal stagingをやり直す。

## Status

Accepted
