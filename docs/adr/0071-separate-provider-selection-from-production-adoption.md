# ADR 0071: provider実装選定とproduction採用を別gateにする

- Status: Accepted
- Date: 2026-08-10
- Target release: `0.2.0`
- Relates to: ADR 0067、ADR 0069、ADR 0070
- Does not authorize: Cloud Run product接続、cloud mutation、staging/production変更、実録音

## Context

[ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)は、bounded-memory coreを使う
Cloud Run GPU Jobを技術的な`Adopt candidate`とした。一方で、speech-like fixtureのlocal比較と実service
staging acceptanceが完了するまでCloud Runをproduct providerとして採用しないとしている。

現行planではPhase 12のprovider固有controllerを実装する前にprovider採用ADRを要求するが、実service
staging acceptanceに必要なcontrollerとone-shot runtimeはPhase 12からPhase 14で初めて作られる。このまま
「採用」を一つの状態として扱うと、stagingで検証する前に採用するか、採用していないためstagingを構築
できないという循環依存になる。

技術的feasibility、実装投資、利用者データを扱うstaging、production routingは、証拠とriskが異なる。
これらを一つの判定へまとめない。

## Decision

- provider decisionを次の3段階に分ける。
  1. `Technical candidate`: 合成inputの隔離probeでruntime、resource、費用、cleanupの成立を確認する。
  2. `Implementation selected`: 非機密speech-like fixtureのlocal native比較とprovider control-plane reviewを
     通過し、synthetic-onlyのprovider実装を開始してよい候補を一つに固定する。
  3. `Production adopted`: 同一candidateの実service staging acceptance、data location、privacy、CI identity、
     parity、rollbackを通過し、新規production attemptのroutingを許可する。
- ADR 0070はCloud Runを`Technical candidate`とする証拠であり、後続2段階を承認しない。
- Phase 10Cでboundaryを跨ぐ非機密・決定的speech-like fixtureを使い、現行full-file inferenceと
  bounded inferenceをlocalで比較する。fixtureは実ユーザー録音または外部corpusを使わず、固定versionの
  local synthesizerから実行時に生成し、repository、CI artifact、logへ音声またはtranscriptを残さない。
- Phase 10C成功後に別ADRで`Implementation selected`を判断する。選定ADRはprovider API、identity、IAM、
  create/reconcile、hard timeout、network、data location、費用、cleanupの実装境界を固定する。
- `Implementation selected`はPhase 12からPhase 14のsynthetic-only実装を許可できるが、利用者traffic、
  production credential、production routingは許可しない。
- Phase 15のformal staging acceptanceが成功し、同じprovider選定ADRをproduction採用へ更新または別ADRで
  承認するまでPhase 16のrouting変更を禁止する。
- Phase 11のprovider-neutral migrationはcloud resourceとprovider switchを作らないため、Phase 10Cと
  provider選定ADRの成否に依存しない。ただしPhase単位を維持するため、現在の作業ではPhase 10Cを先に完了する。
- 各cloud mutationは従来どおり固定review packetと明示承認を必要とする。段階分離は承認範囲を広げない。

## Consequences

- staging acceptance前の「採用済み」という誤表現を避けつつ、staging検証に必要な実装を安全に開始できる。
- local品質比較が失敗した場合、provider controllerやmigrationへ投資する前にbounded algorithm、fixture、
  最大入力時間を再検討できる。
- Phase 14までのprovider固有resourceはsynthetic-onlyであり、実録音と利用者R2 capabilityを扱わない。
- provider実装後もproduction採用は未決定である。release期限や実装量を理由にPhase 15 acceptanceを省略しない。
- decision状態が増えるため、plan、ADR、release evidenceでは3段階のどれを指すか明記する。

## References

- [ADR 0067](./0067-evaluate-cloud-run-gpu-jobs.md)
- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [Bounded transcription quality gate](../bounded-transcription-quality-gate.md)
