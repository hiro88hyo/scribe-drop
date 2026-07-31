# ADR 0061: post-refresh prewarmをWorker再起動証拠へ束縛する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0051、ADR 0059、ADR 0060
- Refined by: [ADR 0062](./0062-require-stable-candidate-evidence-for-stale-running.md)

## Context

ADR 0060のSDK起動設定を含む新imageでformal stagingを実行した。最初のcandidate
prewarm、正常M4A lifecycle、manifestと成果物、post-lifecycle candidate Worker照合は
成功した。Worker recordの作成時刻は同じまま`lastStartedAt`が前進したため、旧job loopの
終了と、`workersMin=1`を満たす同じWorker枠でのcontainer再起動も確認できた。

しかし失敗fixture前の二回目のprewarmでは、provider jobはqueue、in-progressとも0、
GPU telemetryも処理中ではない一方、RunPod healthは8分間`running=1`を返した。endpoint
APIのWorkerはcandidate template/imageに一致して`desiredStatus=RUNNING`だった。prewarmは
fail closedし、failure fixtureとacceptanceを作らず、`workersMin=0`へ復元した。

RunPodの固定SDKでは、refresh後にshutdown eventがjob取得、job実行、stop監視loopを停止し、
`serverless.start`からreturnする。heartbeatはdaemon子processなので親process終了時に停止する。
実測の`lastStartedAt`前進とも整合し、旧application processの残留ではない。RunPodの公開
`/health`仕様はworker poolとjob統計を返すが、control-plane Worker recordとの即時整合性を
保証していない。`running=1`を無条件に許可すると、初回container初期化中や実job処理中を
readyと誤認する。

## Decision

- 初回prewarmは従来どおり、candidate template/imageのactive Workerがexactly 1、
  `idle + ready >= 1`、`running=0`、provider job 0、`initializing/throttled/unhealthy=0`を
  必須にする。
- 初回prewarm成功時にWorker IDと正規化した`lastStartedAt`だけをrunner一時fileへ保存する。
  pathは`runner.temp`直下の固定名に限定し、mode `0600`、exclusive createとする。値を
  log、artifact、GitHub output、リポジトリへ出さない。
- 正常M4A lifecycleとpost-lifecycle candidate Worker照合の後は専用の
  `prewarm-after-refresh`を使う。現在Workerがcandidateに完全一致し、`lastStartedAt`が初回
  evidenceより後であり、Worker IDも初回evidenceと同じであることを必須にする。別IDの
  Workerは同じ枠でのprocess再起動を証明しないため、この限定例外では受理しない。
- 上記refresh証拠がある二回目だけ、provider job 0、active Worker exactly 1、
  `initializing/throttled/unhealthy=0`のとき、通常のidle/readyに加えて
  `idle=0, ready=0, running=1`をprovider healthのstale状態として受理できる。
- refresh証拠なし、初回prewarm、job残存、複数Worker、candidate不一致、未知statusでは
  `running=1`を受理しない。8分上限と失敗時scale-to-zeroを維持する。
- `always()` cooldownでworker evidence fileを削除する。削除、scale-to-zeroのいずれかが
  検証できなければacceptanceを発行しない。
- この変更はWorker image inputを変更しない。ADR 0038に従い検証済みimmutable Worker
  digestを再利用できるが、新commitのcandidate artifact、current-run offline check、SBOM、
  scan、formal staging evidenceは改めて発行する。

## Consequences

- RunPod healthだけを信頼せず、candidate identity、provider job、Worker process再起動時刻を
  組み合わせて二回目のready判定を行える。
- 初回起動やbusy Workerを早取りせず、refresh後だけに観測されたprovider集計遅延を吸収する。
- Worker IDをrunner一時fileで短時間扱うため、path、権限、削除の回帰テストとworkflow静的
  検査が必要になる。
- `workersMin=1`中は再起動後containerが待受し、GPU処理をしていなくても割当と課金が続く。
  acceptance終了時のscale-to-zeroと8分上限は維持する。
- provider healthとWorker recordの不整合自体はRunPod側の調査対象として残る。再発時は
  UTC window、job集計、匿名化したstate遷移をsupport ticketへ追加し、自動retryしない。
