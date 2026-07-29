# ADR 0050: RunPod stock tierをrelease invariantにしない

- Status: Accepted
- Date: 2026-07-29
- Supersedes: ADR 0049の第1GPU候補High/Medium条件

## Context

ADR 0049の実API検証後、candidate publicationの直前確認では`NVIDIA A40`のstockがHigh
だったが、GitHub ActionsのpreflightではLowへ変化した。両時点とも`A40`と`L4`は
`available=true`、`secureCloud=true`、`communityCloud=false`だった。workflowは31秒で
高コストjobを開始せず停止した。

stock tierは短時間で変化する瞬間値であり、candidateをbuildする時点のHigh/Mediumは
staging E2Eやproduction利用時の割当を保証しない。逆にLowでもavailableな複数候補を
持つendpointはworkerを割り当てられる場合がある。GPU処理を行わないcandidate publication
までstock tierで失敗させると、artifact作成とruntime capacityを不必要に結合する。

## Decision

- candidate publicationのRunPod readinessは、API key、endpoint、template listと固定GPU
  候補の存在、`secureCloud=true`、`communityCloud=false`を検証する。`available`と
  `stockStatus`をpublicationの合否に使わない。
- stagingとproductionのpromotionは、remote mutation前に固定2候補が両方とも
  `available=true`であることを必須とする。
- `stockStatus`は運用シグナルとして観測できるが、High、Medium、Lowの値をrelease
  invariant、retry条件、timeout延長条件にしない。
- promotion直前のinventory条件を満たしても、後の割当は保証されたと表現しない。
  staging実E2Eでcandidate workerを確認し、production利用時は10分開始SLO、FAILEDへのCAS、
  exact provider cancelを維持する。
- inventory不足で停止したworkflowを自動retryしない。新しいdispatch前にread-only
  inventoryを確認するが、外部状態が実行中に変わり得ることを明示する。

## Consequences

- 瞬間的なstock tier変動だけでcandidate publicationを赤くしない。
- Secure Cloud境界と、promotion時に2候補が利用可能であることは引き続きfail closedで
  検証する。
- GPU供給を完全には保証できない。staging E2Eまたは利用者jobで割当が得られない場合は、
  bounded SLOで失敗し、同じattemptやworkflowを無条件に再実行しない。
