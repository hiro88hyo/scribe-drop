# ADR 0053: 混在提供GPUを実Worker配置attestation付きで使用する

- Status: Accepted
- Date: 2026-07-29
- Supersedes: ADR 0049の`A40`、`L4`固定候補とSecure-only inventory条件
- Refines: ADR 0050、ADR 0052

## Context

ADR 0049で固定した`A40`と`L4`はGPU種別としてSecure Cloud専用だったが、release
acceptanceのprewarmでは8分以内にWorker割当を得られなかった。inventoryの
`available`や`stockStatus`は個々のServerless Workerが割り当てられる保証ではなく、
供給待ちはCIだけでなく本番利用時の開始SLOにも影響する。

固定`runpodctl`による2026-07-29のread-only inventoryでは、
`NVIDIA GeForce RTX 5090`と`NVIDIA GeForce RTX 4090`はいずれも
`available=true`、`secureCloud=true`、`communityCloud=true`、stock `Low`だった。
隔離したscale-to-zero endpointでの5090検査では短時間でReadyになり、Pod詳細APIから
対象endpoint、immutable candidate image、5090、`secureCloud=true`、`RUNNING`を
確認した後、active workerを0へ戻してendpointを削除した。録音、R2 capability、
実jobは使用していない。4090は既存staging checkpointでSecure Cloud配置を確認済みだが、
この判断のproduction evidenceには新しいstaging acceptanceが必要である。

Serverless endpoint設定はGPU候補の優先順を保持できる一方、Pod作成APIと異なり
cloud typeを固定する設定を提供しない。したがってGPU inventoryだけで個々のWorkerの
Secure Cloud配置を保証できない。ADR 0052で導入したclaim前のPod詳細attestationは、
実際のWorkerごとに`machine.secureCloud`を検証し、不一致時に録音へ到達するcapabilityを
拒否できる。

## Decision

- stagingとproductionのGPU候補を、次の固定順へ変更する。
  1. `NVIDIA GeForce RTX 5090`
  2. `NVIDIA GeForce RTX 4090`
- 3090など上記以外のGPUは、現在の固定inventory条件と隔離検査を満たしていないため
  fallbackへ追加しない。GPU変更は変数だけで行わず、ADR、回帰test、停止中stagingでの
  mutation/read-back、実staging acceptanceを必要とする。
- candidate publicationは両候補がinventoryに存在し`secureCloud=true`であることを
  必須とする。promotionはさらに両候補の`available=true`を必須とする。
  `communityCloud=true`とstock tierは、それ自体をpublicationまたはpromotionの
  失敗条件にしない。
- endpointは固定順を公式REST APIで完全一致read-backする。RunPod planから
  Cloudflareの`RUNPOD_ALLOWED_GPU_IDS`も生成し、手入力によるdriftを許可しない。
- 各claimではwinner CASとR2 capability発行より前にADR 0052の配置attestationを行い、
  対象endpoint、`RUNNING`、immutable candidate image、許可GPU、
  `secureCloud=true`をすべて必須とする。Community Cloud、別GPU、別image、
  field欠落、control-plane障害のWorkerには録音GET URLも成果物PUT URLも発行しない。
- stagingは候補順のendpoint read-back、prewarmしたWorkerのcandidate image、
  許可GPU、Secure Cloud、実jobのclaim attestationを確認するまでproduction-readyと
  しない。本ADRを追加する変更だけではworkflow、endpoint、実jobを実行しない。
- 配置拒否や供給不足でも10分開始SLO、FAILEDへのCAS、exact provider cancelを維持する。
  provider retry、同じattemptの自動再投入、timeoutやtoken TTLの延長は行わない。

## Consequences

- 32 GiBの5090を優先し、24 GiBの4090へfallbackするため、A40/L4だけに固定するより
  割当機会を増やせる。ただしinventoryや過去の隔離検査は将来の割当を保証しない。
- 同じGPU種別がCommunity Cloudにも存在するため、許可できないWorkerが起動してから
  claimを拒否する場合がある。そのWorkerには録音を渡さないが、開始失敗とprovider costは
  発生し得る。
- Secure Cloud保証はdeploy時のGPU種別属性ではなく、個々のWorkerのclaim前attestationへ
  依存する。RunPod control planeの証言であり、暗号学的host identityではない残余リスクは
  ADR 0052から変わらない。
- productionへの反映は、同じrelease commitとimage digestによるstaging acceptanceが
  成功した後に限る。
