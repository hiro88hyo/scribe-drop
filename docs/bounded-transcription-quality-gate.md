# Bounded transcription quality gate

## 1. Status and scope

- Status: Proposed、Phase 10C local gate passed
- Date: 2026-08-10
- Decisions: [ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)、
  [ADR 0071](./adr/0071-separate-provider-selection-from-production-adoption.md)、
  [ADR 0073](./adr/0073-use-adaptive-final-window-lookbehind.md)
- Cloud mutation: なし

本書はbounded-memory windowがmemory上限だけでなく、15分境界の文字起こし品質を維持するかをproduct接続前に
検証する。Phase 10Bの8時間sparse silenceは処理時間とmemoryを証明したが、発話の重複、欠落、日本語の
auto detectionは証明していない。

このPhaseでは現行RunPod、Cloud Run resource、R2、D1、staging、productionを変更しない。local native比較は
固定modelを含むbuild済みworker imageから派生した短命quality imageで行い、networkを無効にする。native比較は
本番workerと同じ`device=cuda`、`compute_type=float16`を固定し、GPU 0だけをcontainerへ公開する。CUDAを
利用できない場合はfixture生成前に失敗させ、CPU fallbackは許可しない。

## 2. Fixture provenance and privacy

- 実ユーザー録音、公開corpus、外部TTS APIを使用しない。
- Ubuntu 24.04 snapshotの固定`espeak-ng` packageと日本語voiceから、固定dummy textを実行時に生成する。
- synthesizerはquality imageだけへ追加し、release worker imageへ含めない。
- 16 kHz、mono、PCM WAVを最大960秒に固定し、異なる短い発話を先頭付近、15分境界を跨ぐ位置、終端付近へ置く。
- fixture、synthesizer中間file、transcript、segment本文は`/tmp`のtask固有directoryだけに置き、終了時に削除する。
- 音声、dummy text、transcriptをstdout、stderr、test report、CI artifactへ出さない。出力は固定terminal markerと
  allowlist済み数値metricだけにする。
- package version、voice、rate、pitch、amplitude、sample rate、配置時刻をcode定数とtestで固定する。

## 3. Native comparison

同じ固定model instanceに対して、次の2経路を順に一度ずつ実行する。

1. reference: 現行full-file入力、`language=auto`、VAD有効。
2. candidate: single FFmpeg decoder、15分core、前後30秒context、monotonic overlap watermark、bounded prompt、
   EOF adaptive final lookbehind、`language=auto`、VAD有効。

referenceは将来残すproduct fallbackではなく、同じmodelとfixtureに対する比較oracleだけである。比較後に
full-file経路を新providerへ接続しない。

textはNFKC正規化後、Unicode letter、mark、numberだけを残して比較する。本文はmetric計算中だけmemoryに保持し、
外へ返さない。Levenshtein distanceは長さ上限を検査し、global normalized character error rateを計算する。
boundaryはVAD segmentが無音を跨ぐことを考慮し、各segmentを既知の3 speech intervalのうち実overlap時間が
最大の1区間へ帰属させ、15分境界に交差する発話だけのrateを計算する。

事前に固定する合格条件は次のとおりである。結果を見て同じPhase内で閾値を緩めない。

- referenceとcandidateの検出言語が`ja`で、probabilityが0.5以上。
- referenceとcandidateのglobal正規化textが24文字以上。
- 15分境界のreferenceとcandidate正規化textが各12文字以上。
- global character error rateが0.05以下。
- boundary character error rateが0.10以下。
- candidate segmentのtimestamp、順序、global ID、durationが既存strict contractを満たす。
- native segment endのpaddingは最大30秒だけをactual window endへclampし、startのwindow外または上限超過を
  拒否する。
- model instance、FFmpeg process、fixture生成、reference、candidateを各1回より多く実行しない。
- 成否にかかわらずtask directoryと全fileが削除される。

native結果が閾値を外れた場合は`Reject`ではなくPhase 10Cを`Revise`とし、segment ownership、context、prompt、
fixture発話配置のどこで差が生じたかを本文を出さないmetricで切り分ける。同じ結果を見て閾値だけを変更しない。

2026-08-11の最初のGPU 0 native runはboundary 94,118 ppmを満たしたが、global 137,681 ppmで失敗し、
[ADR 0072](./adr/0072-revise-bounded-boundary-quality.md)の`Revise`とした。interval別診断で終端partial coreの
短いacoustic contextを原因と特定し、[ADR 0073](./adr/0073-use-adaptive-final-window-lookbehind.md)で最大window内の
EOF lookbehindを採用した。再build後の公式runはglobal 47,101 ppm、boundary 94,118 ppmで成功した。
referenceは276文字/18 segment、candidateは279文字/18 segmentで、両方`ja`、minimum text、cleanupを満たした。
出力はerror ppm、文字数、segment数だけをallowlistし、音声、dummy text、transcript、native例外を含めない。

## 4. Structural matrix

native比較とは別に、networkとnative modelをfakeにして次を通常CIで検証する。

- synthesizerとFFmpegを引数配列で起動し、path、voice、option、output sizeをstrict検証する。
- fixture duration、sample format、3つのspeech interval、15分境界交差、logical/file size上限を検証する。
- empty/oversize/malformed WAV、subprocess timeout/non-zero、symlink、foreign pathを拒否する。
- normalization、bounded edit distance、empty/minimum length、global/boundary閾値の境界値を検証する。
- `ja | en | auto`、VAD true/false、1～3 selected formatのexact propagationはcontract testを再利用し、
  quality gateからtest名と件数をread-backする。native比較1ケースで全組合せを推測しない。
- stdout/stderrとexceptionにdummy text、transcript、path、native errorが含まれないことを検証する。

## 5. Staging acceptance deferred boundary

local成功だけではCloud Runをproduction採用しない。Phase 14のsynthetic dark deploymentとPhase 15のformal
stagingで、同一candidateに次を追加する。

- boundary speech、長発話、日本語auto、英語固定、VAD true/false、selected format 1～3。
- 実R2 download/upload、manifest v3、artifact download、heartbeat/cancel、partial cleanup。
- provider execution、application attempt、artifact、cleanup、課金終了を同じ期限付きevidenceへ結び付ける。
- fixtureと全artifactをacceptance後に削除し、録音またはtranscriptをworkflow artifactへuploadしない。

Phase 10C成功後に許可できるのはprovider実装選定のreviewだけである。production routingはPhase 15の実service
evidenceまでBlockedとする。

## 6. References

- [ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)
- [ADR 0070](./adr/0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0071](./adr/0071-separate-provider-selection-from-production-adoption.md)
- [ADR 0073](./adr/0073-use-adaptive-final-window-lookbehind.md)
- [eSpeak NG supported languages](https://github.com/espeak-ng/espeak-ng/blob/master/docs/languages.md)
- [Ubuntu 24.04 espeak-ng package](https://packages.ubuntu.com/noble/espeak-ng)
