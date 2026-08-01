# ADR 0066: 一時GPU VM実行方式をprovider exit designとして準備する

- Status: Proposed
- Date: 2026-08-01
- Target release if accepted: `0.2.0`
- Excluded release: `0.1.1`
- Relates to: ADR 0043、ADR 0051、ADR 0052、ADR 0065
- Does not supersede: 現行RunPod実装、`docs/spec.md`、`docs/additional-spec.md`

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

一方、既存のWhisper処理、claim後の短期R2 capability、heartbeat、manifest-last、CAS finalize、
notification、保持期限、削除処理はGPU providerから分離できる。実行providerだけを、一処理ごとに
作成して必ず削除するGPU VMへ置き換える設計を先に準備する価値がある。

主要クラウドの公式資料は、少なくとも次のprimitiveが存在することを示す。

- Google Compute EngineはGPU VM、`instances.insert`の`requestId`、Google署名付きinstance
  identity JWT、`maxRunDuration`と自動`DELETE`を提供する。
- Amazon EC2は`RunInstances`の`ClientToken`、署名付きinstance identity document、冪等な
  `TerminateInstances`を提供する。ただし単一VMの短時間hard auto-deleteは別controlが必要である。
- Azure VMはresource名に対するPUT、nonce付きattested metadata、VM delete APIを提供する。
  hard lifetimeは別controlを含めてprobeが必要である。

これらは採用保証ではない。GPU quota、実capacity、boot時間、image固定、network isolation、
課金停止、API整合性は、非機密の隔離probeで実測する必要がある。

## Decision

- [一時GPU VM実行設計](../ephemeral-gpu-vm-design.md)をprovider-neutralなexit designとして
  作成する。現行runtime、staging、productionは変更しない。
- `0.1.1`は現行RunPod構成の修正に限定する。本方式のproduct code、migration、cloud resource、
  credential、workflowは混在させず、採用する場合の最初のreleaseを`0.2.0`とする。version bumpは
  provider移行のfeature Phaseを`develop`へ統合した後、`release/0.2.0`作成時にだけ行う。
- 実行単位ごとに最大1 VMを作成し、処理後は停止ではなくresourceと自動削除対象diskを削除する。
  provider側hard lifetimeも必須とし、Orchestratorとprovider controllerのcleanupに加える第3の
  回収境界とする。
- Cloudflare Orchestratorへ広いcloud IAM credentialを置かない。provider内の小さな
  `GpuVmController`だけが固定policyからVMを作成・取得・削除し、managed identityまたは同等の
  service identityを使用する。Cloudflareからは任意machine spec、startup script、metadata、
  image、networkを指定できない。
- VM metadata、startup data、provider queueへclaim token、R2 URL、R2 credential、job ID、
  attempt ID、利用者情報を置かない。VMへ渡すのは単独では権限を持たないopaque execution handle
  だけとする。
- VMはprovider署名付きinstance identity evidenceをOrchestratorへ提示する。Orchestratorは署名、
  audienceまたはnonce、発行時刻、project/account、region/zone、instance ID、作成時刻を検証し、
  provider control planeから固定image、GPU、service identity、network、hard lifetime、RUNNINGを
  exact read-backする。すべて一致した後だけwinner CASと短期R2 capability発行を行う。
- workload terminal report、manifest、全artifact、current attemptに加え、VMが削除済みまたは
  exact resourceの不存在を確認してから利用者向け`COMPLETED`へ遷移する。provider statusや
  VM shutdownだけでは完了扱いにしない。
- create timeoutは失敗確定とみなさない。決定的resource nameとproviderのidempotency keyから
  exact resourceをreconcileし、結果不明のまま別VMを作らない。retryは新generationと
  新attemptだけで行う。
- job/attemptの公開状態は維持し、provider resource lifecycleは別aggregateとして保存する。
  RunPod固有DB列をその場でrenameせず、forward-onlyのexpand、dual-read/dual-write、contract
  switch、後続contract migrationの順に置き換える。
- 初期同時実行は全provider合計1、public IPなし、inbound ruleなし、Network Volumeなし、
  runtime install/downloadなし、固定image、処理ごとの削除を必須とする。Spot/preemptibleは
  interruption recoveryを実証するまで採用しない。
- 最初の実現性probe候補はGoogle Compute Engineとする。署名付きidentity tokenがexact audienceと
  instance claimsを持ち、hard auto-deleteをVM設定へ埋め込めるためである。これはprovider採用の
  決定ではなく、課金、project、quota、IAM、GPU resourceを作成する前に利用者承認を必要とする。
- RunPod supportが必要な保証を提供できる場合も、この設計はprovider portabilityとexit planとして
  保持する。RunPodが保証しない場合、別ADRで本ADRをAcceptedへ変更し、normative specを同期して
  段階的移行を開始する。

## Adoption gates

probeとproduct migrationを同じ「実装開始条件」にせず、次の3段階に分ける。

### Probe authorization

1. RunPod supportの保証範囲または保証不能を記録し、`0.1.1`をreleaseするか未releaseで閉じるかを
   明示する。support回答を無期限に待つことは`0.2.0`の設計継続条件にしない。
2. provider comparison、data処理境界、region、quota、GPU SKU、見積上限費用を文書化する。
3. 作成するresource、全IAM permission、credential配置、hard lifetime、cleanup、費用上限を
   一覧にし、利用者が一度にreviewしてCPU/GPU probeを承認する。

### Product migration entry

1. CPU VMでidentity、idempotent create、unknown outcome reconciliation、no-public-IP、hard delete、
   orphan cleanup、課金停止を確認する。
2. 合成mediaだけを使う単一GPU probeで、起動SLO、固定image、GPU、identity、処理、削除、
   課金停止を確認する。
3. probe結果とprovider選定を別ADRへ記録し、本ADRをAcceptedへ変更してnormative specを同期する。
   ここまでproduct runtime、D1 schema、staging、productionを変更しない。

### Production cutover

1. provider-neutral compatibility、controller、VM adapterをPhaseごとにlocal検証する。
2. local fault injection、staging shadow、formal staging acceptanceを順に成功させる。
3. exact VMとdiskの不存在、capability失効、費用guard、rollback手順まで検証するまでproductionを
   変更しない。

## Consequences

- providerの曖昧なqueue/healthではなく、実resource ID、署名付きidentity、provider API read-back、
  delete operationを証拠にできる。
- VM作成と削除、provider controller、identity verifier、forward-only DB migrationが増え、
  Serverlessより実装量は大きい。
- cold startとGPU capacity shortage自体は消えない。ただし作成失敗、結果不明、RUNNING、削除、
  課金中resourceを同じexecution aggregateで観測・回収できる。
- hard auto-delete、最大同時実行1、controllerの独立hard ceilingによって孤児課金の上限を定義できる。
- provider operatorとhostへの信頼は残る。署名付きinstance identityはcontrol planeの証言であり、
  暗号学的なGPU host attestationではない。
- Proposedの間はproduct code、migration、staging、production、通常CI/CDを変更しない。Probe
  authorization後のPhase 9/10だけは、product runtimeから隔離したbounded harnessと一時resourceを
  明示承認の範囲内で許可し、各probe終了時にresource不存在を確認する。
