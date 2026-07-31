# ADR 0060: worker refresh後にRunPod job loopをローカル終了する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0006、ADR 0051、ADR 0059

## Context

terminal失敗通知を含むformal stagingで、正常M4A lifecycleとcandidate Worker照合は成功した。
Worker handlerは全結果へ`refresh_worker=true`を返したが、失敗fixture前の二回目のprewarmでは
旧Workerとみられるinstanceのuptimeが増え続け、queueが空でも8分以内にidle/ready条件へ
収束しなかった。prewarmは失敗し、`always()` cleanupによる`workersMin=0`復元は成功した。
failure fixtureとacceptanceは作成されなかった。

固定RunPod SDK 1.11.0では、handler outputの`refresh_worker`はjob resultから除去され、
control plane向けの`stopPod=true`へ変換される。一方、`serverless.start`設定の
`refresh_worker=true`は同じ停止要求に加え、result送信後に`JobScaler`のshutdown eventを
設定してjob取得loopをローカルでも終了する。従来のentrypointはhandlerだけをSDKへ登録し、
ローカル終了設定を渡していなかったため、control planeの停止反映だけに依存していた。

一時録音はtask固有`TemporaryDirectory`で削除し、runtimeのHTTP clientもhandler return前に
closeしている。processをresult送信前に強制終了するとjob完了通知を失うため、独自signal、
`os._exit`、subprocess killを追加してはならない。

## Decision

- `runpod.serverless.start`へ`handler`と`refresh_worker=true`を同時に渡す。
- handler outputの`refresh_worker=true`も維持する。固定SDK上では両方が同じ
  `stopPod=true`へ収束し、起動設定はresult送信後のローカルjob loop終了も保証する。
- 正常、検証失敗、runtime失敗、cleanup失敗のすべてでrefreshを要求する。未知入力を
  runtime構築前に拒否した場合も起動設定によりWorkerを再利用しない。
- entrypoint unit testはSDKへ渡す設定keyを完全一致で検証し、`refresh_worker`がboolean
  `true`であることを必須にする。handler testはoutput側のrefresh要求とruntime closeを
  引き続き検証する。
- stagingは最初のjob後も交換candidate Workerのidle/readyを確認してから次のfixtureを
  作成する。queue-only条件へ弱めず、交換GPUが割り当たらない場合は自動retryしない。
- この変更はWorker image inputを変更するため、既存image digest、candidate、staging
  acceptanceを再利用しない。新imageをbuild、offline check、SBOM生成、scanした後に同じ
  formal stagingを1回実行する。

## Consequences

- control planeのPod停止反映だけに依存せず、SDK自身もjob取得loopを終了する。
- result送信、task cleanup、client closeの順序は維持され、録音やcapabilityを保持したまま
  次jobを取得する経路を減らせる。
- Workerをjobごとに交換するため、cold start、GPU再配置、料金、供給不足の影響は残る。
  これはdata isolationを優先する既存判断であり、worker再利用へ変更する場合は別ADR、
  threat analysis、利用者承認を必要とする。
- RunPodがshutdown後のWorker recordやhealth counterを遅延更新する可能性は残る。
  readiness不成立時はacceptanceを発行せず、scale-to-zeroをexact read-backする。
