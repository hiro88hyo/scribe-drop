# ADR 0022: Bootstrap production dependencies before applications

## Context

`docs/implementation-plan.md`の通常のrelease順序は、migration、Orchestrator、Web、
RunPod imageとendpointの順である。これは既存endpointを維持したままapplicationを
後方互換に更新する場合には安全だが、初回production bootstrapには適用できない。

新規environmentではOrchestratorの必須secretである`RUNPOD_ENDPOINT_ID`をapplication
deploy前に確定する必要がある。一方、RunPod Workerの`ORCHESTRATOR_ORIGIN`は
Orchestrator deploy前でも予約済みのproduction originとしてtemplateへ設定できる。
active workerを0に保ち、利用者trafficをまだ許可しなければ、endpointを先に作成しても
jobは実行されない。

## Decision

初回production bootstrapでは次の依存順序を使用する。

1. Cloudflareのenvironment専用resource、origin、Access境界を作成するが、利用者trafficは
   許可しない。
2. release commitから検査済みRunPod imageを発行し、digestを固定する。
3. 固定imageからproduction専用templateとendpointを作成する。active workersは0とし、
   endpointへjobを投入しない。
4. endpoint IDを含むenvironment専用secretを登録する。
5. forward-only migrationを適用し、Orchestrator、Webの順でapplicationをdeployする。
6. Access、binding、Queue、Cron、RunPod invariantをread-onlyで検証してから、初回workerと
   end-to-end smokeを実行する。
7. smoke dataを清掃し、trafficを許可するrelease判断を別checkpointで行う。

既存productionを更新するreleaseでは、互換なmigrationとOrchestrator/Webを先にdeployし、
検証済みの旧endpointを維持したまま新RunPod revisionへ切り替える。contractに
後方互換性がない場合はこの順序を使わず、expand/migrate/contractを複数releaseへ分割する。

## Consequences

- 初回bootstrapと通常updateでrunbookを分ける必要がある。
- RunPod endpointを先に作成しても、application deployとreadiness確認まではworkerを
  起動せずjobを投入しない。
- production origin、resource ID、image digest、secretは追跡対象へ保存しない。
- 手順途中で失敗した場合、未公開のresourceは自動削除せず、追跡外stateから再開または
  review済みrollbackを選ぶ。
- production設定renderer、secret verifier、Access verifier、image publication workflowが
  揃うまでproduction deployを開始しない。

## Status

Accepted
