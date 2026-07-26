# ADR 0014: RunPod API subrequestはpublic fetch routingを使う

- Status: Accepted
- Date: 2026-07-26

## Context

Phase 5のstaging smokeで、OrchestratorからRunPodの公開APIへ送る`/run` subrequestが
HTTP応答を得る前に失敗した。RunPod API keyとendpointはproject-local `runpodctl`および
同一payloadの直接requestでは成功し、D1には120〜160 ms程度で
`submission_outcome = 'unknown'`が記録された。Brotli、identity、gzipを明示した場合も
deployed Workerではrequest境界で失敗したため、response encodingやstrict JSON schemaは
原因ではない。

RunPodのAPI hostnameは公開Internet上のCloudflare経由endpointである。Cloudflare Workersの
global `fetch()`は、compatibility flagがない場合にWorker-backed hostnameをpublic
Internetと同じ経路で解決するとは限らない。RunPod、Discord、R2 S3 APIはいずれも
Orchestratorから公開endpointとして利用する必要があり、同一zoneのprivate origin routingを
利用する要件はない。

## Decision

- Orchestrator Workerに`global_fetch_strictly_public` compatibility flagを設定する。
- flagは追跡対象の`apps/orchestrator/wrangler.toml`をsource of truthとし、local、
  staging、productionで同じrouting semanticsを使う。
- RunPod API originはcode上の`https://api.runpod.ai`へ固定し、endpoint IDとjob IDだけを
  schema検証後にpath segmentへencodeする。redirectは引き続き拒否する。
- RunPod JSON control APIは`Accept-Encoding: gzip`を明示し、bounded streaming readerと
  strict response schemaを維持する。
- Discord webhookは既存のHTTPS host/path allowlist、R2は固定account endpointと
  object scopeを維持する。利用者入力から任意のoutbound hostnameを作らない。
- `fetch`失敗時はresponse bodyやraw exceptionをlogせず、
  `RUNPOD_REQUEST_FAILED`だけを記録する。結果不明submissionを同じattemptで再送しない。

## Consequences

- global `fetch()`はCloudflare内部のprivate origin shortcutではなく、公開Internetからの
  requestと同じfront doorへ送られる。Cloudflare側の公開routing、security policy、
  rate limit、障害の影響を受ける。
- 将来Orchestrator間通信を追加する場合、このflagをprivate service discoveryの代用に
  しない。同一account/zoneの内部通信はService Bindingを別途設計する。
- public routingを有効にしてもSSRF対策にはならない。固定origin、host allowlist、
  redirect拒否、schema検証を継続する。
- rollbackでflagを外すとRunPod submissionが再び結果不明になる可能性があるため、
  application versionとWrangler設定を一体でrollbackする。

## References

- [Cloudflare Workers: Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Workers: Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Cloudflare Workers: Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)
