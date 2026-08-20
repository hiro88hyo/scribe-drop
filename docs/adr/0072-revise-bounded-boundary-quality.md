# ADR 0072: bounded boundary qualityをReviseとして維持する

- Status: Superseded by ADR 0073
- Date: 2026-08-11
- Relates to: ADR 0069、ADR 0070、ADR 0071
- Cloud mutation: なし

## Context

Phase 10Bはbounded-memory経路の処理時間とmemory上限を満たしたが、15分境界のspeech品質は未実測だった。
Phase 10Cでは固定modelを含むrelease worker imageから短命quality imageを派生し、GPU 0、networkなし、
read-only root filesystem、`device=cuda`、`compute_type=float16`でfull-file referenceとbounded candidateを
比較した。

初回native runは`QUALITY_REJECTED`だった。本文を出さない診断metricは、reference 281文字/16 segment、
candidate 211文字/8 segment、global error 249,110 ppm、boundary error 513,043 ppmだった。両経路の
languageは`ja`、probabilityは0.956055で、durationも960秒で一致した。

調査で次の設計・実装不整合を確認した。

- quality oracleだけがnative segmentの`end <= media duration`を要求していたが、現行full-file adapterは
  この追加制約を持たず、model paddingでreferenceが非決定的に拒否された。
- 設計は3つの異なる発話を要求していたが、fixture実装は同じTTS PCMを3回複製していた。
- 同じ境界発話のsegment midpointが先行windowでは900.02秒、後続windowでは899.64秒となり、固定core
  midpoint ownershipでは両windowから除外されるcoverage holeが生じた。
- VAD segmentが無音を跨ぐため、単純なinterval overlapは終端発話の全文をboundary metricへ混入した。
- TTS rate、終端余白、短いedge発話の候補を個別にnative比較したが、いずれも事前global閾値を満たさなかった。

## Decision

- global 0.05、boundary 0.10、最低文字数、language、CUDA/float16条件は変更しない。
- referenceは現行full-file adapterと同じtimestamp境界に戻す。candidateだけは全segmentがmedia duration内に
  あることをstrict検証する。
- fixtureは固定された異なる3つの日本語TTS発話を個別生成する。先頭、15分境界を跨ぐ発話、終端付近という
  placement、960秒上限、voice、rate、pitch、amplitudeは固定し、音声と本文を保持・出力しない。
- merge候補は先行windowを優先する。最後に採用したglobal endをmonotonic watermarkとし、後続windowでは
  global midpointがwatermarkを越えるsegmentだけを採用する。次windowのacoustic context内に残るtextは
  `initial_prompt`へ重複させない。
- boundary比較では各segmentを3つの既知speech intervalのうち実overlap時間が最大の1区間へ帰属させる。
  全文global比較は従来どおり全segmentを対象にする。
- rate threshold到達後のfailureにも、本文を含まないerror ppm、文字数、segment数をallowlist形式で出力する。
- この候補の最終native runはboundary 94,118 ppmで0.10以内だったが、global 137,681 ppmで0.05を超えた。
  Phase 10Cは`Revise`のままとし、provider implementation selection、cloud mutation、production routingへ
  進まない。

## Consequences

- midpoint driftによるcoverage holeとboundary metricへの無関係text混入は再現テストで固定される。
- distinct fixtureとmonotonic watermarkはproduct serviceへ未接続の候補であり、native global gate成功まで
  採用済みalgorithmとして扱わない。
- 次のrevisionでは結果を見て閾値を緩めず、window間のtext reconciliation、Whisper/VAD timestamp復元、
  またはfixture oracle設計を別reviewする。
- ADR 0073でEOF時のadaptive lookbehindとbounded timestamp normalizationを採用し、同じ閾値のnative gateを
  成功させた。本ADRは最初の`Revise`判定と棄却した候補の記録として残す。
- CI workflow、Cloud Run、RunPod、R2、D1、staging、production resourceは変更しない。

## References

- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0071](./0071-separate-provider-selection-from-production-adoption.md)
- [ADR 0073](./0073-use-adaptive-final-window-lookbehind.md)
- [bounded transcription quality gate](../bounded-transcription-quality-gate.md)
