# ADR 0051: staging job作成前にcandidate Workerを実割り当てする

- Status: Accepted
- Date: 2026-07-29
- Refines: ADR 0043、ADR 0050のstaging release gate

## Context

release candidateのpublication、artifact hash検証、RunPod template/image/capacity read-back、
固定GPU 2候補の`available=true`を確認した後、staging promotionは成功した。しかし実M4A
acceptanceでは、RunPodがjobを受理してから10分間`inQueue=1`、Worker 0件のままで、
Playwrightのterminal待機上限に達した。D1、Pages、R2、Orchestrator、Access、candidate
manifestの失敗ではなかった。

過去に成功した同じE2Eの所要時間は約1.5分、7.3分、7.9分だった。短いtimeoutへ変更すると
正常なcold startを拒否する一方、長いtimeoutへ変更してもGPU供給を改善せず、利用者jobと
短命capabilityをprovider queueへ先に投入する問題を残す。

RunPod inventoryの`available`と`stockStatus`は瞬間的なcontrol-plane signalであり、GPUの
即時割り当てを保証しない。RunPodのActive workerは`workersMin=1`によりjobなしで起動でき、
workerがreadyになってから利用者処理を投入できる。ただし常時Active workerはidle中も課金
されるため、productionへ暗黙に適用してはならない。

失敗したsynthetic jobは`finally`のowner-scoped deleteからRunPod cancelを受理し、D1/R2の
cleanup後にprovider queueからも消えた。ADR 0043の開始SLOは10分だが、5分Cronで収束させる
ためterminal化とcancel反映は次のCron境界まで遅れ得る。「10分ちょうどでprovider cancel
まで完了する」と表現してはならない。

## Decision

- staging acceptanceは実M4A jobを作成する前に、candidate endpointを一時的に
  `workersMin=1`へ変更する。
- prewarmはcandidate template ID、immutable image digest、固定GPU候補、endpoint設定を
  exact read-backし、candidate Worker 1件とhealth上のready/running状態を確認してから成功
  とする。inventoryの`available`だけをready evidenceにしない。
- prewarm上限は8分とする。これは過去の成功E2E実測を拒否しない範囲で、GPU未割り当て時に
  synthetic jobを作らず停止するためのrelease gateである。
- mutation responseは再送しない。`workersMin`のexact read-backを正とし、応答喪失時も
  read-backが一致した場合だけ続行する。
- prewarmが失敗した場合は同じ処理内で`workersMin=0`を復元し、exact read-backする。
  workflowにも`always()` cleanupを置き、成功、E2E失敗、後続検証失敗のすべてで
  scale-to-zeroを復元する。cooldownはexact endpoint IDと固定名を確認する一方、
  candidate template/imageのdriftを課金停止の前提にしない。復元を確認できなければ
  acceptanceを発行しない。
- E2E後、scale-to-zeroへ戻す前にcandidate Workerのtemplate/image evidenceを取得する。
- productionの固定planは`workersMin=0`を維持する。常時Active workerへの変更は月額費用、
  想定traffic、開始遅延SLOを明示した別ADRと利用者承認なしに行わない。
- production promotionは、このprewarmを含むstaging acceptanceが成功するまで開始しない。
- ADR 0043の10分開始SLO、FAILEDへのCAS、exact provider job cancelは維持する。ただし
  5分Cron境界により収束完了は10分を超え得ることを運用文書と利用者表示で明示する。

## Consequences

- GPU供給不足は、実データ経路へsynthetic jobを作成する前に最大8分で検出できる。
- staging acceptance中だけActive worker料金が発生する。成功・失敗後に`workersMin=0`を
  exact read-backするため、常時課金へ暗黙に移行しない。
- prewarmはcandidate containerが実GPU上でreadyになったことを証明するが、将来の
  production Flex worker割り当てまでは保証しない。productionの低遅延を保証するには、
  常時Active worker、保証容量、または別providerへのfailover判断が別途必要である。
- GitHub Actionsの最大時間はcleanup余裕を含め25分だが、GPU未割り当て時はE2Eを開始せず
  prewarm上限で停止する。timeoutを延ばして同じprovider jobを待ち続けない。
