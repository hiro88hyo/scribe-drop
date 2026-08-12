# ADR 0067: Cloud Run GPU Jobを最初のprovider隔離probeとして評価する

- Status: Proposed（隔離probe成功、技術的Adopt candidate、product採用は未決定）
- Date: 2026-08-10
- Target release if accepted: `0.2.0`
- Relates to: ADR 0065、ADR 0066
- Partially supersedes: ADR 0066の「RunPod Podsだけを現行probe対象とする」決定
- Does not supersede: 現行RunPod実装、provider-neutral migration設計、`docs/spec.md`、
  `docs/additional-spec.md`

## Context

RunPod Serverlessは、全compatible GPUとregionを評価してcapacityがない場合も、公開APIで
capacity待ちと他の`IN_QUEUE`を区別できない。RunPod Podsはresource lifecycleを直接扱える一方、
public IP、create冪等性、署名付きinstance identity、provider側hard lifetimeの4点を公開仕様だけで
解決できず、隔離probeの前提がBlockedである。

Cloud Run Jobsは、HTTP serviceを公開せずcontainerを終了まで実行し、task timeoutで停止する
managed batch境界を提供する。GPU JobはL4またはRTX PRO 6000を1台付与でき、L4は
`asia-southeast1`で利用できる。Job、task、retry、parallelism、timeout、GPU、CPU、memory、
service identityを作成時に固定し、JobとexecutionをAPIでread-backおよび削除できる。

既存worker imageはCUDA 12.8.1である一方、Cloud Run L4の標準driverは535.x（CUDA 12.2）である。
CUDA 12系のminor version compatibilityだけでCTranslate2と固定modelが動くか、forward compatibility
packageまたは別base imageが必要かは、ローカルCPU環境では確定できない。この不確実性を本番データや
R2 capabilityを渡さない合成GPU probeで判定する価値がある。

## Decision

- RunPod Podsのsupport確認とmutation probeを停止し、最初の外部GPU probeをCloud Run Jobとする。
- [Cloud Run GPU隔離probe](../cloud-run-gpu-probe.md)をresource、IAM、cost、stop、cleanupの
  source of truthとする。
- probeは既存staging/production、Cloudflare、RunPod resourceを変更せず、固定synthetic WAVだけを
  使用する。録音、文字起こし本文、R2 URL/credential、Cloudflare secretを渡さない。
- probe用JobはL4 1台、`asia-southeast1`、task 1、parallelism 1、retry 0、timeout 10分、
  4 vCPU、16 GiB、zonal redundancyなしに固定する。
- dedicated user-managed service accountにはproject roleを付けない。JobはGoogle APIを呼ばず、
  inbound serviceとlistenerを持たない。
- local harnessはCloud Runのtask count/index/attemptと固定model pathをPydanticでexact検証し、
  CUDA deviceが1台であることを確認してから、固定modelで1秒の合成音声を一度だけ推論する。
  Cloud Loggingへ出すapplication logはallowlist済みterminal codeだけとする。
- cloud mutation前にoperator identity、project、billing、quota、既存同名resource 0、image digest、
  全IAM capability、最大費用を一度にread-backしてreviewする。
- 成否にかかわらずexecution、Job、Artifact Registry repository、probe service accountを削除し、
  実行中instance 0と対象resource不存在を独立確認する。API有効化は課金resourceではないため、
  既存projectへの影響を避けて自動disableしない。
- probe成功はprovider採用を意味しない。実録音を扱う設計、R2 capability、controller、D1 migration、
  staging/production、CI/CDは別ADRでCloud Run採用を決定するまで変更しない。

## Probe outcome

2026-08-10にfixed manifestの隔離probeを一度だけ実行し、技術的feasibilityをAdopt candidateとした。
repositoryへ実project、account、service account、Job/Execution、image digestは記録しない。

- cloud mutation前にbilling有効、必要API、operator capability 19項目、同名resource 0をread-backした。
- L4 non-zonal redundancyの`asia-southeast1`実効quotaは3であった。
- Job作成後、digest固定、無権限runtime identity、task/parallelism 1、retry 0、timeout 10分、
  4 vCPU、16 GiB、L4 1台、固定command/environmentの14項目がAPI read-backと一致した。
- executionは一度だけ作成され、client開始から90秒以内に成功した。allowlist済みsuccess markerは
  1件、failure markerは0件、execution総数は1件であった。
- 同じ既存CUDA 12.8.1 imageと固定modelで合成音声推論が成功した。forward compatibility package、
  CUDA 12.2系image、RTX PRO 6000への変更や推測による再実行は不要であった。
- terminal確認後にJobとexecution、dedicated repository/image、runtime service accountを削除し、
  各同名resourceが0件であることをread-backした。継続課金resourceは残していない。
- 実請求額はBillingへの反映後に確認する。API有効化は課金resourceではなく、既存projectへの影響を
  避けて自動disableしていない。

この結果は、1回のL4 compatibility、lifecycle、cleanupを証明する。継続的capacity、起動SLO、
最大入力時間、実録音data plane、data location、CI identity、staging parityは証明しないため、
product採用は別ADRまで未決定とする。

## Consequences

- managed Jobの終了条件と最大1時間のGPU task timeoutにより、RunPod Podsで未解決だった
  provider側hard lifetime相当の境界を評価できる。
- Jobは公開HTTP endpointを持たず、合成probeのruntime service accountを無権限にできるため、
  public IPを持つPodより小さい初期attack surfaceで検証できる。
- Cloud Run自体のcapacityは予約ではない。quota付与、image pull、GPU割当、cold start、maintenance、
  region availabilityを実測し、RunPodより常に利用可能だとは仮定しない。
- exact probe candidateについてL4のdriver/CUDA/model compatibilityは確認できた。この単発成功を
  将来image、別region、継続capacityへ一般化せず、candidate変更時はlocal gateと隔離probe証拠を
  無効化する。
- Job実行中はGPU、CPU、memoryがinstance lifetime全体で課金され、最低1分課金される。10分timeoutは
  費用上限を狭めるがCloud Billing budgetのhard capではない。
- gcloud、Artifact Registry、IAMという新しいoperator surfaceが増える。product採用時はlocal user
  credentialをruntimeへ流用せず、CI workload identityとleast privilegeを別途設計する。

## References

- [Cloud Run Jobs GPU configuration](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu)
- [Cloud Run container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud Run task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [NVIDIA CUDA minor version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
