# ADR 0015: Workersの外部fetchは実行時のplatform contextを保持する

- Status: Accepted
- Date: 2026-07-26

## Context

Phase 5のstaging smokeでは、RunPodの公開APIへ送るsubrequestがHTTP応答を得る前に
120〜160 ms程度で失敗した。API key、endpoint、payloadはproject-local
`runpodctl`と同一payloadの直接requestで検証済みであり、response encodingを
identityまたはgzipへ変更しても結果は変わらなかった。

[ADR 0014](./0014-runpod-api-uses-public-fetch-routing.md)で
`global_fetch_strictly_public`を設定した後も、deployed Workerは同じ
`RUNPOD_REQUEST_FAILED`へ遷移した。このためpublic routingの選択は原因ではなく、
不要なcompatibility flagを維持する根拠もない。

実装を再確認すると、module globalの`fetch`をclient生成時に関数値として保存し、
後から呼び出していた。Workersのhost提供APIはrequest handlerの実行中に利用し、
platform objectの呼び出しcontextを保持する必要がある。RunPod clientとDiscord clientは
同じ実装パターンを使用していた。

## Decision

- production adapterはclient生成時にglobal `fetch`の関数値を保存しない。
- request実行時にwrapperから`globalThis.fetch(input, init)`を呼び、Workersの
  platform contextとrequest lifetimeを保持する。
- unit testでは明示的に注入した`fetch`を使い、production adapterの回帰テストでは
  client生成後にplatform `fetch`を解決することを検証する。
- RunPod API origin、Discord webhook host、redirect拒否、timeout、bounded response、
  strict schema、safe error codeは変更しない。
- `global_fetch_strictly_public`はWrangler設定から削除する。
- 結果不明のsubmissionは引き続き同じattemptで再送しない。

## Consequences

- module初期化時やclient生成時にWorkersのI/O関数を切り離さず、subrequestをactiveな
  event handlerの実行中に開始する。
- RunPodと同じパターンだったDiscord通知にも修正を適用し、完了後の通知だけが別原因で
  失敗することを防ぐ。
- public/private routingの意味を変更するcompatibility flagへ依存しない。将来
  Service Bindingが必要になった場合は、global fetchの代用にせず専用adapterを設計する。
- staging smokeでRunPod submissionのaccepted記録、claim、artifact、通知を確認するまで
  end-to-end制御は未検証として扱う。

## References

- [Cloudflare Workers: Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Workers: The Request context](https://developers.cloudflare.com/workers/runtime-apis/request/)
