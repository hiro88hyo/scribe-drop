# ADR 0062: stale runningを安定candidate証拠へ束縛する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0051、ADR 0059、ADR 0061

## Context

ADR 0061を含むcandidateは全local gate、current-run offline check、SBOM、scanを通過し、
formal stagingのpreflightと全promotionも成功した。しかし最初の合成M4Aを作成する前の
prewarmで、RunPod healthがready条件へ収束せず8分上限でfail closedした。実jobは作成されず、
fixture cleanupと`workersMin=0`のexact read-backは成功した。その直後、active Workerが0でも
`/health`は`running=1`を返しており、Worker recordとhealth集計の不整合を再確認した。

RunPodの公開仕様はQueue endpointの`/health`をworker availabilityとjob queueのquick overview
として説明するが、個別Worker recordとの即時整合性や`running`のready判定を保証していない。
Active Workerはwarm and readyを意図する設定である一方、`running=1`を単発でready扱いすると
起動直後、再起動loop、実job処理中を早取りし得る。逆に`running=0`だけを必須にすると、
provider集計がstaleな場合にcandidateが起動済みでも合成fixtureへ到達できない。

formal stagingの最初の入力はリポジトリ生成の合成M4Aであり、利用者dataではない。したがって
candidate identityと無仕事状態を複数回安定確認した後に限り、その合成job自体をQueue Workerの
実行可能性を証明するlive acceptanceとして使える。

## Decision

- 通常のready条件は維持する。candidate template/imageに一致するactive Workerがexactly 1、
  `idle + ready >= 1`、`running=0`、provider job 0、
  `initializing/throttled/unhealthy=0`なら直ちにprewarm成功とする。
- stale healthの限定形は`idle=0, ready=0, running=1`だけとする。candidate完全一致、単一
  active Worker、provider job 0、異常state 0を同時に必須とする。
- 限定形ではWorker IDと`lastStartedAt`が同じ観測を3回連続で要求する。15秒pollのため最低30秒
  安定していることになる。job出現、異常state、Worker交換、process再起動、別health形が一度でも
  現れたら確認回数を0へ戻す。
- 初回prewarmでは上記3回の安定証拠がある場合だけstale `running=1`を受理し、その後に投入する
  合成M4A lifecycleを実ready証拠とする。この例外はstaging release workflow専用であり、
  production利用者dataのadmission条件へ流用しない。
- post-refresh prewarmではADR 0061の条件も維持する。初回と同じWorker ID、前進した
  `lastStartedAt`を必須にした上で、stale `running=1`には同じ3回連続確認を追加する。
- timeout時は最後のmode、active Worker数、job数、health counter、refresh確認有無、連続確認数
  だけを安全なerrorへ含める。Worker ID、時刻、image、endpoint ID、provider bodyはlogへ出さない。
- 8分上限、mutation非retry、失敗時scale-to-zero、`always()` cleanupを維持する。
- この変更はWorker image inputを変更しない。検証済みimmutable digestを再利用できるが、
  新commitのcandidate、current-run supply-chain evidence、formal staging acceptanceは再発行する。

## Consequences

- `/health`の単発分類をreadyの唯一の根拠にせず、control-plane candidate identity、process安定性、
  job/異常state、実合成jobを組み合わせられる。
- 初回起動中や再起動loopを30秒未満で早取りせず、provider集計が長時間staleな場合だけ吸収する。
- Queue Workerの最終的な実行可能性は正常M4A lifecycle、manifest、全成果物、downloadまで含む
  formal stagingで検証される。
- 次回timeout時は秘密を漏らさず最後の判定要因を一度で特定できる。
- RunPod healthとWorker recordの不整合はprovider側の調査対象として残る。自動workflow retryは
  行わない。
