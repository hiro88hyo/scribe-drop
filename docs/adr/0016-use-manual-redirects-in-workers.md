# ADR 0016: Workersの外部fetchはmanual redirectでfail closedにする

- Status: Accepted
- Date: 2026-07-26

## Context

Phase 5のstaging smokeでは、RunPodの公開APIへ送るsubrequestがHTTP応答を得る前に
120〜160 ms程度で失敗した。API key、endpoint、payloadはproject-local
`runpodctl`と同一payloadの直接requestで検証済みであり、response encodingとpublic
routingを変更しても結果は変わらなかった。

dummy endpointとdummy credentialだけを使った一時的なWorkers integration診断でも、
同じ`RUNPOD_REQUEST_FAILED`を再現した。clientのcatchを外すと、固定したWorkers
runtimeは`redirect: "error"`を無効な値としてrequest構築時に`TypeError`で拒否した。
通信開始前に失敗するため、RunPod credentialやprovider応答は原因ではなかった。

CloudflareのRequest文書では、`manual`は3xx responseを呼び出し側へそのまま返し、
`follow`は`Authorization`を含むheaderを別hostへ転送し得ると説明されている。本実装は
provider redirectへ追従する要件がなく、redirect先を利用する必要もない。

## Decision

- RunPod、Discord、Google OAuth JWKS、Cloud Run controllerを含むWorkersからの外向き`fetch`は
  `redirect: "manual"`を指定する。
- 3xx responseを追従せず、既存の非成功HTTP statusとしてfail closedに分類する。
- `Location` header、redirect先body、provider error bodyを読み取らず、logにも残さない。
- RunPod API origin、Discord webhook host、timeout、bounded response、strict schema、
  safe error codeは変更しない。
- Workers integration testで実際の`Request`を構築し、redirect modeが`manual`として
  受理されることを検証する。通常CIから実providerへ接続しない。
- 結果不明のsubmissionは引き続き同じattemptで再送しない。
- 効果がなかった`global_fetch_strictly_public`はWrangler設定から削除する。

## Consequences

- Workers runtimeがrequest構築時に拒否していたRunPod submissionを送信できる。
- RunPodやDiscordが3xxを返した場合は自動追従せず、submission/control/notification
  ごとの既存failure分類へ入る。
- credentialをredirect先へ転送しないため、`follow`へ変更してはならない。
- [ADR 0014](./0014-runpod-api-uses-public-fetch-routing.md)のpublic routing仮説と
  [ADR 0015](./0015-preserve-workers-fetch-context.md)のplatform context仮説は、
  staging結果と同一runtimeでの再現によりsupersedeする。
- 修正後のstaging smokeでRunPod submissionのaccepted記録、claim、artifact、finalize、
  Discord通知まで確認した。
- Phase 14のGoogle OAuth JWKS verifierがこの制約に反して`redirect: "error"`を指定した際も、
  live Workers runtimeは通信開始前に`TypeError`で拒否した。`manual`へ統一し、3xxを非成功statusとして
  fail closedに扱う既存方針を適用する。
- Workers host `fetch`をport objectのmethodとして呼ぶと誤ったreceiverを渡すため、注入関数をlocal変数へ
  取り出してstandaloneで呼ぶ。receiver-sensitive回帰testでGoogle JWKSとcontrollerの両経路を固定する。

## References

- [Cloudflare Workers: Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Cloudflare Workers: Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
