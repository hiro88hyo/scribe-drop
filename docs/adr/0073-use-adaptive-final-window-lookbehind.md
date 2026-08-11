# ADR 0073: final windowでboundedなadaptive lookbehindを使う

- Status: Accepted（Phase 10C local quality gate）
- Date: 2026-08-11
- Relates to: ADR 0069、ADR 0070、ADR 0072
- Cloud mutation: なし
- Does not authorize: provider implementation selection、追加GPU execution、staging/production変更

## Context

ADR 0072のmonotonic watermark候補は15分境界のrateを94,118 ppmまで改善したが、global rateは
137,681 ppmで事前上限50,000 ppmを超えた。本文を出さないinterval別診断では、先頭57,471 ppm、境界
94,118 ppm、終端240,385 ppmで、終端発話が主因だった。

同じ960秒fixtureをpath入力とsingle FFmpegの全長float32 ndarray入力で比較すると、global/boundaryとも
0 ppmで完全一致した。一方、最終partial coreへ従来どおり30秒だけ過去contextを付けた90秒windowでは
終端差が残った。decoderやmergeではなく、EOF付近の短いinference windowに不足するacoustic contextが
原因である。

最大windowを超えてmemoryを増やす、quality閾値を緩める、fixture本文を結果に合わせて変更する方法は採らない。

## Decision

- decoderは常に直近最大960秒だけをrolling保持する。通常coreは従来どおり前後30秒contextで早期に処理するが、
  EOFで確定する最終windowは`max(0, actual end - 960秒)`まで過去側へ拡張する。
- rolling trimは次の通常window開始と直近960秒の早い方を保持し、peak decode bufferを従来の
  `MAX_WINDOW_BYTES + READ_CHUNK_BYTES`以内に保つ。8時間全体を保持しない。
- adaptive final windowが通常の30秒lookbehindより前へ広がる場合、既存promptはacoustic inputと重複し得るため
  `initial_prompt`を渡さない。検出済みlanguage、VAD、その他のimmutable optionsは変更しない。
- faster-whisper/VADが実音声末尾から最大30秒までsegment endをpaddingする既知境界をcandidate側で正規化する。
  segment startがwindow外、またはendがwindow end + 30秒を超える場合は拒否し、許可範囲内のendだけをactual
  window endへclampする。永続化するcandidate timestampは引き続きmedia duration内とする。
- 先行window優先、monotonic watermark、distinct fixture、maximum-overlap boundary assignment、global 0.05、
  boundary 0.10、language/minimum text/cleanup条件は変更しない。
- 変更後imageのGPU 0、networkなし、read-only、CUDA/float16 native runはglobal 47,101 ppm、boundary
  94,118 ppmで成功した。referenceは276文字/18 segment、candidateは279文字/18 segmentだった。

## Consequences

- 最終partial coreは従来より長い音声を再推論し得るが、1 window 960秒、model instance 1、FFmpeg process 1、
  rolling buffer上限は変わらない。
- Phase 10Cのlocal quality gateは完了する。ただしproduct serviceへの接続、provider選定、cloud mutation、
  production routingは許可しない。
- Phase 10BのCloud Run実測は変更前imageによるhistorical evidenceとして保持するが、変更後candidateと同一artifact
  ではない。新candidateのperformance evidenceとして流用せず、必要なcloud再測定には新review packetと明示承認を
  要求する。
- CI workflow、Cloud Run、RunPod、R2、D1、staging、production resourceは変更しない。

## References

- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0072](./0072-revise-bounded-boundary-quality.md)
- [bounded-memory transcription design](../bounded-memory-transcription-design.md)
- [bounded transcription quality gate](../bounded-transcription-quality-gate.md)
