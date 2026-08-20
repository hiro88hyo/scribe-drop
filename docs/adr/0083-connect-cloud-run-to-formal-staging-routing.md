# ADR 0083: Cloud Runをformal staging routingへ接続する

## Context

Phase 14はCloud Run Jobs上のexact one L4 execution、runtime identity、R2 capability、manifest、artifact、
cleanupをsynthetic shadow routeで実証した。しかし通常のupload QueueはRunPodだけを選択し、Cloud Run runtimeの
terminal eventもproductのjob、artifact、notification outboxへ反映していなかった。この状態ではPhase 15の
formal staging acceptanceを通常の利用者経路で実行できない。

provider切替の途中でQueue replay、create response loss、cancel、利用者deleteが発生すると、同じattemptを別providerへ
二重投入したり、Cloud Run resourceのcleanup確認前にD1/R2を削除したりする危険がある。既存のPhase 14 candidate
`cdfc394`は、この接続実装のsource変更によってstaging evidenceとして失効する。

## Decision

- `GPU_EXECUTION_POLICY`を新規attemptの選択境界とし、`runpod_serverless_v1`を全environmentの既定値にする。
  `cloud_run_jobs_l4_v1`はstagingかつ`CLOUD_RUN_RUNTIME_MODE=synthetic-shadow`の場合だけ許可し、productionでは拒否する。
- provider kind、policy、contract version、optionsをgeneration-one attempt作成時に保存する。Queue replayとCron dispatchは
  保存済みselectionを使い、後の環境変数変更で既存attemptを別providerへ送らない。
- Cloud Run execution handleはattempt IDから一方向に決定的導出する。D1でglobal active attemptをclaimしてからcontrollerへ
  exact create requestを送り、response loss時は有効期限内に同一requestを1回だけ再送する。unknown outcomeは新規executionを
  作らず、controller version 0からreconcileする。
- controller response versionをD1へ保存する。stale responseはcontrollerが返すactual versionだけを反映し、job/attemptの
  状態を後退させない。Cronはobserve、reconcile、cancel、cleanupと未投入Cloud Run attempt 1件のdispatchをbounded batchで行う。
- runtime bootstrapがcontroller observeより先に到着しても、live attestationのcontroller versionと一緒にexecution、attempt、
  jobを原子的に`RUNNING`へ昇格させる。
- runtime terminalを先にD1のallowlist eventへ記録し、成功時はbounded manifest v2と選択format、exact result key、全artifactの
  R2 sizeを検証してからartifact、job、attempt、notification outboxを原子的に確定する。失敗・cancelもproduct terminalへ
  収束させ、その後だけcontroller cleanupを要求する。controllerだけが先にterminalになった場合は5分のruntime report
  graceを置き、それでもproduct terminalがなければ失敗へ収束させる。
- cancel/deleteはCloud Run provider aggregateへ伝播する。利用者deleteとretentionはCloud Run cleanupが`SUCCEEDED`になるまで
  R2/D1の物理削除を拒否する。switchをRunPodへ戻しても既存Cloud Run attemptのreconciliationとcleanupは継続する。
- この変更をlocal gateに通してcommitした後、新candidateを一度だけbuildし、Phase 14のstaging dark deploymentからやり直す。
  CI、staging resource、productionはlocal gate完了前に変更しない。

## Consequences

- staging switchは新規attemptにだけ作用し、rollbackでprovider codeやreaperを外さずに新規Cloud Run投入を停止できる。
- RunPod固有列と`runpod_submissions`はrollback互換のため残る。Cloud Run handle/version/cleanupの正は
  `provider_executions`に置き、legacy RunPod mirror列へ書かない。
- create requestがcontrollerへ一度も到達しなかった場合はreconcileが`CONFLICT`へ閉じ、別executionを自動作成しない。
  resource不存在を安全に証明できない間はcleanup未完了としてdeleteを止め、運用調査対象にする。
- manifestのSHA-256はGPU workerが生成した値を保存し、OrchestratorはR2 HEADでexact keyとsizeを再検証する。R2 APIが
  object digestを返さないため本文の再hashは行わず、この残余リスクをPhase 15 acceptanceで再評価する。
- `cdfc394`とworkflow run `31695586010`のPhase 14成功証拠は実装選定の根拠として保持するが、Phase 15 promotion evidenceには
  使用できない。

## Status

Accepted
