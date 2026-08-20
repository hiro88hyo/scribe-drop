# ADR 0085: 利用者cancelを既存Queueで即時dispatchする

## Context

Phase 15のsource `c03fd7f`を使ったformal stagingで、実行中のCloud Run jobに対してWeb UIから
cancelを一度だけ要求した。D1のjobとattemptは直ちに`CANCEL_REQUESTED`へ遷移したが、controllerの
cancel requestは0件のままで、44秒後にruntime terminal failureが先に確定した。Webのcancel handlerは
D1だけを更新し、provider control-planeへの伝播は5分ごとのOrchestrator Cronだけに依存していたためである。

Webへcontroller credentialや公開control endpointを追加すると、所有者向けHTTP境界とprovider管理境界が
混在する。Cron間隔を短くすると、cancelの有無にかかわらず継続的なD1/controller pollが増える。stagingと
productionには既にR2 object notificationを受ける環境別QueueとOrchestrator consumerがあり、Pages Functionsは
同じQueueへのproducer bindingを持てる。

## Decision

- Webは従来どおりAccess JWT、CSRF、Origin、Content-Type、ownerを検証し、D1のcancel状態を先に原子的に確定する。
  `CANCEL_REQUESTED`となった場合だけ、strictなschema version 1の`job-control` eventを環境別の既存
  `recording-uploaded-<environment>` Queueへawaitして送る。eventはaction、event ID、job ID、UTC request時刻だけを
  含み、owner、credential、provider handleを含めない。
- Queue送信に失敗したHTTP requestは成功を返さない。D1は既にcancel requestedなので、利用者の再送は冪等なD1
  read-backから新しいbounded eventを再配送できる。Queueのduplicate deliveryも許容する。5分Cronは配送不能時の
  回復経路として残す。
- Queue consumerは`job-control`をR2 notificationとのstrict unionとして境界で判別する。未知fieldや不正IDを含む
  control eventはprovider操作へ渡さない。既存R2 eventのaccount、bucket、object検証は変更しない。
- control event自体を認可情報として扱わない。OrchestratorはD1 primaryから指定jobのcurrent active attemptを再読込し、
  job/attemptがともに`CANCEL_REQUESTED`、provider kind/policyがCloud Run、exact provider handleが存在し、executionが
  cancel可能な場合だけcontroller requestを作る。対象外、terminal、RunPod、productionでCloud Run未採用のeventはno-opで
  ackする。
- controller requestは従来のHMAC、30秒expiry、persisted version CAS、同一requestの最大1回transport replay、
  `STALE_VERSION`後の最大1回bounded recoveryを共有する。effect不明またはD1 CAS競合はmessage単位でjitter付きretryし、
  上限後は既存DLQへ送る。
- 新しいQueue resourceは作らない。Webの`CONTROL_EVENTS` producer bindingをtracked staging/production Wrangler configへ
  追加し、candidate read-backはPages production configのexact binding、main Queueのproducer 2件（R2とWeb）、
  Orchestrator consumer 1件を必須とする。dashboardだけのbindingは認めない。

## Consequences

- 通常の利用者cancelは次の5分CronではなくQueue配送後に対象jobだけをcontrollerへ伝播できる。controller secretと
  provider handleはOrchestratorから外へ出ない。
- Queueはuploadとcontrolの2種類を運ぶため、consumer log、retry、DLQの運用ではevent種別を区別する必要がある。
  ただしresource、retention、consumer数は増えない。
- Queue送信とD1 mutationを単一transactionにはできない。D1先行、HTTP再送、Queue at-least-once、Cron fallbackの組合せで
  lost wake-upを回復し、provider mutationはD1/controller双方のversion条件で重複を抑止する。
- このsource変更で`c03fd7f` candidateのstaging evidenceはpromotionへ使用できない。local gate後の新commitから一度だけ
  buildし、Phase 14 gateとPhase 15 acceptanceをやり直す。修正時点ではremote staging、GPU、CI、productionを変更しない。

## Status

Accepted
