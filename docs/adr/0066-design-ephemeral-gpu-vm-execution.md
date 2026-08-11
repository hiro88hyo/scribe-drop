# ADR 0066: 一時RunPod GPU Pod実行方式をprovider exit designとして準備する

- Status: Proposed（RunPod Pods評価は停止、provider-neutral設計だけ維持。ADR 0067参照）
- Date: 2026-08-01
- Last reviewed: 2026-08-10
- Target release if accepted: `0.2.0`
- Excluded release: `0.1.1`
- Relates to: ADR 0043、ADR 0051、ADR 0052、ADR 0065
- Does not supersede: 現行RunPod実装、`docs/spec.md`、`docs/additional-spec.md`
- Partially superseded by: ADR 0067（現行probeをRunPod Podsだけに限定する決定）

> 2026-08-10追記: 利用者承認により、最初の隔離probeをCloud Run GPU Jobへ変更した。
> 本文のRunPod Pods固有packetは比較候補の履歴として残すが、mutation、support確認、product実装を
> 進めない。現在のprobe境界は[ADR 0067](./0067-evaluate-cloud-run-gpu-jobs.md)と
> [Cloud Run GPU隔離probe](../cloud-run-gpu-probe.md)を正とする。

## Context

ScribeDropは録音を外部GPUへ渡す前に、実Worker、immutable image、GPU、実行環境を検証し、
検証不能ならR2 capabilityを発行しない。RunPod Serverlessではglobal inventory、data center別
inventory、endpoint GPU設定、Serverless GPU poolが利用可能性を示しても、実Workerが作成
されない事象を繰り返し観測した。またhealth、Worker一覧、Console、image pull eventの間に、
利用者がauthoritativeとみなせる一貫したresource lifecycleを確認できていない。

ADR 0065のstaging prewarmでは、3つの相異なるServerless GPU pool、`Any Region`、表示上の
在庫を確認した後も8分間Workerが作成されなかった。fail-closed、job作成前prewarm、
scale-to-zero cleanupは正しく機能したが、providerが厳格な事前attestationとresource lifecycle
を保証しない場合、同じServerless API上でpreflightを追加し続けてもproduction品質は得られない。

2026-08-06の追加probeでは、`workersMin=1`のexact read-backだけでなく、固定dummy requestを
`IN_QUEUE`へ投入して10分間維持してもWorkerは作成されなかった。RunPod supportは2026-08-10までに、
全compatible GPU type、全available region、全fallbackをSchedulerが評価したがcapacityがなく、
公開APIにはGPU capacity待ちとその他の`IN_QUEUE`を区別するstatusがないと確認した。これは
endpoint固有故障の証拠ではないが、Serverlessのcapacityを事前保証できず、待機理由を自動分類
できないことを確定する。無条件retryや待機上限延長では解決しない。

一方、既存のWhisper処理、claim後の短期R2 capability、heartbeat、manifest-last、CAS finalize、
notification、保持期限、削除処理はGPU providerから分離できる。実行providerだけを、一処理ごとに
作成して必ずterminateするRunPod GPU Podへ置き換える設計を先に準備する価値がある。

RunPod Podsの公式資料は、Secure Cloud GPU Podの作成、machine/GPU/priceのread-back、明示的な
terminate、秒単位課金を提供する。一方、Secure Cloud Podは常にpublic IPを持つと明記され、
create冪等key、provider署名付きinstance identity、provider側hard lifetimeは公開仕様で確認できない。
RunPod Podsを採用するには、これらの保証をsupport回答と非機密の隔離probeで確認し、必要なら
security invariantの変更を別ADR、脅威分析、回帰testでreviewする必要がある。

## Decision

- [一時GPU Pod実行設計](../ephemeral-gpu-vm-design.md)をprovider-neutralなexit designとして
  作成する。現行runtime、staging、productionは変更しない。
- `0.1.1`は現行RunPod構成の修正に限定する。本方式のproduct code、migration、cloud resource、
  credential、workflowは混在させず、採用する場合の最初のreleaseを`0.2.0`とする。version bumpは
  provider移行のfeature Phaseを`develop`へ統合した後、`release/0.2.0`作成時にだけ行う。
- 実行単位ごとに最大1 Podを作成し、処理後はstopではなくPodとpersistent storageをterminateする。
  provider側hard lifetimeも必須とし、Orchestratorとprovider controllerのcleanupに加える第3の
  回収境界とする。
- RunPod credentialのscopeがaccount全体へ及ぶ場合はCloudflareへ直接置く前に分離control境界を
  脅威分析する。`GpuExecutionController`だけが固定policyからPodを作成・取得・terminateし、
  callerから任意machine spec、command、metadata、image、networkを指定できないようにする。
- Pod environment、command、provider queueへclaim token、R2 URL、R2 credential、job ID、
  attempt ID、利用者情報を置かない。Podへ渡すのは単独では権限を持たないopaque execution handle
  だけとする。
- PodはRunPodが提供する場合にprovider署名付きinstance identity evidenceをOrchestratorへ提示する。Orchestratorは署名、
  audienceまたはnonce、発行時刻、account、data center、Pod/machine ID、作成時刻を検証し、
  provider control planeから固定image、GPU、Secure Cloud、network、hard lifetime、RUNNINGを
  exact read-backする。すべて一致した後だけwinner CASと短期R2 capability発行を行う。
- workload terminal report、manifest、全artifact、current attemptに加え、terminate後のPodと
  persistent storageの不存在を確認してから利用者向け`COMPLETED`へ遷移する。provider statusや
  Pod process終了やstopだけでは完了扱いにしない。
- create timeoutは失敗確定とみなさない。決定的resource nameとproviderのidempotency keyから
  exact resourceをreconcileし、結果不明のまま別Podを作らない。retryは新generationと
  新attemptだけで行う。
- job/attemptの公開状態は維持し、provider resource lifecycleは別aggregateとして保存する。
  RunPod固有DB列をその場でrenameせず、forward-onlyのexpand、dual-read/dual-write、contract
  switch、後続contract migrationの順に置き換える。
- 初期同時実行は全provider合計1、public IPなし、inbound ruleなし、Network Volumeなし、
  runtime install/downloadなし、固定image、処理ごとの削除を必須とする。interruptibleは
  interruption recoveryを実証するまで採用しない。
- Phase 8以降の候補はRunPod Podsとする。結果とprobe範囲は
  [provider decision packet](../ephemeral-gpu-vm-provider-decision.md)を正とする。既存account、container、
  GPU catalogを再利用でき、実行時間単価がServerlessと大きく変わらない場合に運用上単純である。
  他cloud providerは現行計画のprobe対象にしない。
- RunPod Podsを第一候補とすることは、公開IP、create冪等性、instance identity、hard lifetimeの
  mandatory gapを受容する決定ではない。公式保証またはreview済み代替controlで解決するまで
  mutationを伴うprobeとproduct採用を開始せず、security invariantを暗黙に緩めない。
- RunPod Serverlessの保証不能は[ADR 0065](./0065-validate-runpod-serverless-gpu-pools.md)へ記録済み
  であり、Phase 8のRunPod Pods評価を開始する。provider採用、product code、migration、cloud mutationは
  Phase 10のprobe承認と実測を経るまで開始しない。

## Adoption gates

probeとproduct migrationを同じ「実装開始条件」にせず、次の3段階に分ける。

### Probe authorization

1. RunPod supportの保証不能を記録する。これは2026-08-10に[ADR 0065](./0065-validate-runpod-serverless-gpu-pools.md)
   で完了した。`0.1.1`はmain/tagへ入れず未releaseで閉じ、fail-closed検証だけを別PRで`develop`へ戻す。
2. RunPod Podsのmandatory capability、data処理境界、data center、capacity、GPU SKU、見積上限費用を
   文書化する。
3. probeで作成するresource、credential配置、hard lifetime、cleanup、費用上限を
   一覧にし、利用者が一度にreviewして合成GPU Pod probeを承認する。

上記2と3のdraftを[provider decision packet](../ephemeral-gpu-vm-provider-decision.md)として作成した。
RunPod supportが4つのmandatory gapへ回答し、単価、GPU allowlist、最大課金時間をread-backして
利用者がpacket全体を明示承認するまでは、Pod作成、credential登録、staging/production変更を行わない。

### Product migration entry

1. offline contract testでidentity、idempotent create、unknown outcome reconciliation、network policy、
   hard delete、orphan cleanup、課金停止の期待動作を固定する。
2. 合成mediaだけを使う単一RunPod Secure Cloud GPU Pod probeで、起動SLO、固定image、GPU、identity、処理、削除、
   課金停止を確認する。
3. probe結果とprovider選定を別ADRへ記録し、本ADRをAcceptedへ変更してnormative specを同期する。
   ここまでproduct runtime、D1 schema、staging、productionを変更しない。

### Production cutover

1. provider-neutral compatibility、controller、Pod adapterをPhaseごとにlocal検証する。
2. local fault injection、staging shadow、formal staging acceptanceを順に成功させる。
3. exact Podとpersistent storageの不存在、capability失効、費用guard、rollback手順まで検証するまでproductionを
   変更しない。

## Consequences

- providerの曖昧なqueue/healthではなく、実resource ID、署名付きidentity、provider API read-back、
  terminate operationを証拠にできる。
- Pod作成とterminate、provider controller、identity verifier、forward-only DB migrationが増え、
  Serverlessより実装量は大きい。
- cold startとGPU capacity shortage自体は消えない。ただし作成失敗、結果不明、RUNNING、削除、
  課金中resourceを同じexecution aggregateで観測・回収できる。
- provider hard lifetimeまたはreview済み代替control、最大同時実行1、controllerの独立hard ceilingを
  組み合わせられた場合は、孤児課金の上限を定義できる。
- provider operatorとhostへの信頼は残る。署名付きinstance identityはcontrol planeの証言であり、
  暗号学的なGPU host attestationではない。
- Proposedの間はproduct code、migration、staging、production、通常CI/CDを変更しない。Phase 9は
  local fakeだけに限定し、probe authorization後のPhase 10だけはproduct runtimeから隔離したbounded
  harnessと一時resourceを明示承認の範囲内で許可して、終了時にresource不存在を確認する。
