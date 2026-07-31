# ADR 0017: 固定ffprobeの実JSONをstrict schemaとcontainer checkで検証する

- Status: Accepted
- Date: 2026-07-26

## Context

Phase 5のstaging smokeでは、RunPod submission、winner claim、heartbeatまで成功したが、
有効なMP3が`INVALID_MEDIA`としてfail closedになった。sourceは35秒、16 kHz、monoの
MP3であり、固定しているFFmpeg 6.1.1で直接probeするとcodec、container、durationは
許可範囲内だった。

同じFFmpeg packageの実JSONには、`-show_entries`で指定した`streams`と`format`に加え、
空の`programs` fieldが含まれる。`ProbeOutput`は`extra="forbid"`である一方、このfieldを
宣言していなかったため、実mediaをすべてschema違反として拒否していた。unit fixtureは
実出力に存在するfieldを省略しており、container checkもffprobeのversion確認だけで
production adapterを実行していなかった。

## Decision

- `ProbeOutput.programs`を空tupleとして明示し、空配列だけを受理する。
- `extra="forbid"`を維持し、未知fieldや非空のprogram情報を暗黙に無視しない。
- unit fixtureを固定FFmpeg 6.1.1の実JSONへ合わせ、非空`programs`の拒否を検証する。
- container checkはtask固有`/tmp`に1秒のsynthetic silent WAVを生成し、production
  `FfprobeMediaProbe`でcodec、container、duration、stream数を検証する。
- synthetic fixtureは実録音、利用者data、文字起こしdataを含めない。

## Consequences

- 固定ffprobeが返す既知の空container fieldを受理しつつ、外部process境界のstrict性を
  維持する。
- ffprobe packageやcommand outputが変わりproduction adapterとschemaがずれた場合、
  networkなし・read-only root filesystemのcontainer checkで検出できる。
- Python codeを含むRunPod imageを再buildし、digest固定でstaging templateを更新してから
  end-to-end smokeを再実行する必要がある。修正版のstaging smokeでは同じ実mediaが
  production probe、GPU推論、manifest/artifact検証を通り、job完了まで到達した。
- `INVALID_MEDIA`の外部error contractは変更しない。
