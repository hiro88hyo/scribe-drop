# ADR 0069: 最大8時間入力をbounded-memory windowで逐次文字起こしする

- Status: Accepted（synthetic-only実装。production routingは未採用）
- Date: 2026-08-10
- Target release if accepted: `0.2.0`
- Relates to: ADR 0068
- Outcome evidence: ADR 0070、ADR 0072、ADR 0073、ADR 0075、ADR 0076
- Does not change yet: 現行RunPod runtime、staging/production、最大録音時間8時間

## Context

[ADR 0068](./0068-benchmark-cloud-run-eight-hour-input.md)のCloud Run L4 benchmarkでは、8時間PCMを
一度の`faster-whisper.transcribe`へ渡したtaskが16 GiBのmemory limitで終了した。固定versionの
faster-whisperはpath入力をPyAVで全量float32 arrayへdecodeし、その後VADとfeature extractionも全音声を
対象にする。providerやGPUだけを変更しても、最大入力に比例するhost memory allocationは残る。

現行workerは音声全体だけでなく、全segmentとMarkdown、JSON、SRTの3成果物もmemoryへ同時に保持する。
さらに監査で、job作成時の`language`、`vad`、`outputFormats`がworker claimへ渡らず、workerが常に
`language=None`、`vad_filter=True`、3形式生成で動く既存contract不整合を確認した。bounded-memory化で
同じ経路を変更する以上、この不整合を暗黙に温存しない。

最大録音時間8時間を直ちに下げる前に、入力時間に比例しないmemory上限と、利用者が確定したoptionsを
attemptへ結び付ける方式をofflineで検証する必要がある。

## Decision

- 1 attemptは引き続き1 provider execution、1 GPU、1 taskで処理する。Cloud Runの複数taskへchunkを
  分散しない。language、previous-text context、manifest-last、cancel、winner、cleanupを一つの順序付き
  state machineに保つ。
- sourceはclaim後にtask固有scratchへ一度だけdownloadし、size、ETag、ffprobe、duration、stream、codecを
  現行どおり検証する。Cloud Runではscratchをsize limit 3 GiBの専用in-memory volumeへmountし、組み込み
  filesystemへの無制限writeを禁止する。
- ffprobeが選んだexact audio streamを、固定引数のFFmpeg process一つで16 kHz、mono、float32 PCMへ
  sequential decodeする。URLをprocessへ渡さず、shell、runtime download、repeated seekを使わない。
- transcription coreは15分のhalf-open core intervalと前後30秒contextからなるwindowを順番に処理する。
  最大windowは16分、float32 PCMは61,440,000 bytes（約58.6 MiB）である。decoder stdout、current
  window、次windowを無制限にprefetchしない。
- decoderは直近最大16分をrolling保持し、EOFで確定する最終partial coreだけを過去側へ最大windowまで
  adaptiveに拡張する。拡張windowではacoustic inputと重複する`initial_prompt`を渡さない。
- `condition_on_previous_text=true`は各window内で維持する。次windowには、直前までに採用したsegmentから
  作る最大8 KiB UTF-8の`initial_prompt`だけを渡す。prompt、segment、本文をlogへ出さない。
- windowのraw segmentはlocal timestampをstrict検証してglobal timestampへ変換する。Phase 10Cで固定core
  midpointのsegmentation driftによるcoverage holeを確認したため、[ADR 0072](./0072-revise-bounded-boundary-quality.md)
  の候補では先行windowを優先し、最後に採用したglobal endをmonotonic watermarkとして後続overlapを除く。
  採用時に連番IDを再発行し、raw segmentは1 window 10,000件で打ち切る。
- native segmentがwindow末尾を最大30秒paddingした場合はendだけをactual window endへclampする。startが
  window外、またはpadding上限超過は拒否し、永続化timestampをmedia duration内に保つ。
- attempt作成時にjob optionsをimmutable snapshotとして保存する。execution contract v2は固定model、
  `language: ja | auto`、`vad`、canonical `outputFormats`を含む。`ja`は全windowへ固定し、`auto`は最初の
  windowで一度だけ検出して後続へ固定する。
- result manifestは`schemaVersion: 2`と`executionContractVersion: 2`を持ち、attempt snapshotと同じ
  requested format集合および選択された1～3形式だけを含む。
  各artifact keyのjob、attempt、format拡張子もmanifest自身の値と再照合する。
  unrequested objectへのPUT capabilityを発行しない。v1 attemptとv2 attemptをcontract versionで明確に
  分離し、v2 completionがv1 manifestへfallbackしない。
- segmentはbounded spoolへ逐次書き、memoryに全件保持しない。segment 100,000件、1 segment 16 KiB
  UTF-8、本文合計64 MiB、spool 128 MiB、各artifact 128 MiBをhard limitとする。artifactは1形式ずつ
  fileへ生成し、sizeとSHA-256を同時に計算してstreaming PUT後に削除する。manifestは全選択artifactの
  upload成功後にだけ書く。
- decode、inference、spool、artifact、uploadの各safe pointでheartbeat/cancelを確認する。失敗またはcancel
  時はFFmpegを終了し、task固有scratchを`finally`で削除する。partial artifactはmanifestなしのまま既存の
  exact attempt-prefix cleanupへ収束させる。
- このADRがProposedの間はproduct serviceへ接続しない。まず同じcoreをisolated benchmark entrypointで
  local検証し、local全gateと新review packet完了後に限り、L4、4 vCPU、16 GiBのexact 1 executionで
  8時間full-scanを再測定する。

Phase 10Aでは上記のprovider非依存core、Python/TypeScript contract parity、manifest-last artifact fake、
最大8時間のvirtual PCM container checkをproduct serviceへ未接続で実装した。Cloud re-probeの固定境界は
[bounded Cloud Run re-probe review packet](../cloud-run-bounded-eight-hour-reprobe.md)を正とする。ADRのStatusは
Phase 10Bの実測とprovider採用判断まで`Proposed`のままとする。

Phase 10Bは2026-08-10にexact one executionで成功し、処理時間254秒、billable instance time 180.02秒、
peak container memory 0.578 GiB、peak tmpfs 0.0079 GiB、peak GPU memory 2.363 GiBだった。executionと
task attemptは各1、success marker 1、failure/retry/OOM 0で、全専用resourceを0件へcleanupした。この結果は
[ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)で`Adopt candidate`と判定した。
Phase 10B時点ではboundary品質とproduct provider採用が未決定だったため、このADRのStatusを`Proposed`のまま
維持した。

Phase 10Cは[ADR 0073](./0073-use-adaptive-final-window-lookbehind.md)のadaptive final windowでlocal native
quality gateを満たした。ただしalgorithm変更後のimageはPhase 10Bで実行したdigestと異なるため、ADR 0070の
performance値を新candidateへ継承しなかった。後続[ADR 0075](./0075-revalidate-adaptive-eof-worker-before-provider-selection.md)
でexact current imageのCloud Run L4 revalidationを完了し、[ADR 0076](./0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)
がCloud Run Jobsを`Implementation selected`としたため、本ADRをsynthetic-only実装についてAcceptedへ変更する。
実録音、staging/production接続、production routingは引き続き別gateである。

詳細な境界、algorithm、contract移行、test matrixは
[bounded-memory transcription design](../bounded-memory-transcription-design.md)を正とする。

## Consequences

- 音声decodeとfeature extractionのpeak allocationは8時間全体ではなく最大16分windowへ制限される。
- 一つのFFmpeg decodeと一つのmodel instanceを使うため、provider task分散による重複download、複数winner、
  prompt競合、部分manifestを増やさない。
- 30秒contextとbounded promptでboundary品質を保つが、全8時間を一度に処理した場合とbyte-for-byte同じ
  transcriptは保証しない。boundary、silence、長発話、日本語、auto languageのfixture比較が必要になる。
- source、spool、artifactは依然としてsensitive temporary dataである。size-limited volume、mode 0600、
  task固有directory、finally cleanup、no-logを必須とする。
- options contractとmanifest v2はmigrationと全consumer更新を必要とする。旧attemptとのdual-read期間を
  持つが、同一attemptでversionを推測またはfallbackしない。
- 16 GiBでpeak memory、処理時間、quality gateを満たせなければmemory増量を繰り返さず、別ADRでchunk
  policy、Cloud Run GPU SKU、または最大入力時間を再決定する。

## References

- [ADR 0068](./0068-benchmark-cloud-run-eight-hour-input.md)
- [faster-whisper 1.2.1 transcribe implementation](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py)
- [faster-whisper 1.2.1 audio decode implementation](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/audio.py)
- [Cloud Run container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud Run Jobs in-memory volumes](https://docs.cloud.google.com/run/docs/configuring/jobs/in-memory-volume-mounts)
- [Cloud Run Jobs](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run metrics](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0073](./0073-use-adaptive-final-window-lookbehind.md)
- [ADR 0075](./0075-revalidate-adaptive-eof-worker-before-provider-selection.md)
- [ADR 0076](./0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)
