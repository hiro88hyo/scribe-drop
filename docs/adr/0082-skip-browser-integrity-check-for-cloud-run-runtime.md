# ADR 0082: Cloud Run runtimeのexact pathだけBrowser Integrity Checkをskipする

## Context

Phase 14のcandidate `810189b`をstagingでexact 1回実行したところ、Cloud Run L4、image
import、container起動は成功したが、runtimeはbootstrap前に`SESSION_REJECTED`で終了した。
Executionはtask 1、parallelism 1、retry 0、exit code 1で、D1 bootstrap/session event、R2
capability、source download、CUDA/model load、artifactは0だった。

同じ署名済みworker imageとruntime service accountを使うGPUなしprobeでは、Google metadata
identity tokenのheader、claim型、audience、issuer、service account email、subject binding、
1時間lifetimeがすべて現行contractと一致した。一方、実bootstrap POSTはHTTP 403、17 byte、
non-JSONとなり、同時のWorkers tailへ到達しなかった。このPCから同じendpointへ送る無効JSONは
Workerの`INVALID_REQUEST` JSONを返した。Cloudflare Security EventsはCloud Run Singapore ASNの
probeを`action=block`、`source=bic`として記録した。Browser Integrity Checkがapplicationの
Google OIDC検証より前に正規のmachine clientを拒否していた。

BICはbrowser向けのheader heuristicであり、Cloud Run runtimeの認証境界ではない。runtimeは
bootstrapのGoogle OIDC、exact runtime service account、D1 active attempt、controllerによる
live Cloud Run Job/Execution manifest attestationを満たすまでcapabilityを発行しない。後続requestも
single-use challengeとmemory-only session tokenへ固定される。

## Decision

- zone全体のBICを無効化しない。
- staging hostname、queryなし、POST、次のexact 5 pathをすべて満たすrequestだけ、zone-level
  custom ruleの`skip` actionでproduct `bic`だけをskipする。
  - `/internal/cloud-run/bootstrap`
  - `/internal/cloud-run/claim`
  - `/internal/cloud-run/ack`
  - `/internal/cloud-run/heartbeat`
  - `/internal/cloud-run/terminal`
- skip ruleのloggingを有効のまま維持する。WAF managed rules、rate limiting、Security Level、
  User Agent Blocking、その他のproduct/phase/rulesetをskipしない。
- `scripts/cloud-run-waf-rule.mjs`をexact planとstrict read-backの正とし、関連ruleの欠落、重複、
  path/method/host/query/product/logging driftを拒否する。
- live管理はlocal credential storeへ一時注入するstaging専用`CLOUDFLARE_WAF_API_TOKEN`だけで行う。
  exact staging zoneの`Zone WAF Edit`と`Zone Read`以外を与えず、CI、production、Worker secretへ
  保存しない。既存Backend/Access tokenの権限は増やさない。実zone/originは追跡せず、local環境の
  `CLOUDFLARE_ZONE_NAME`と`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`を相互検証してruleを生成する。
- productionへ同じ例外を自動作成しない。production cutover前にproduction固有hostname、Access/
  WAF構成、実runtime evidenceを別のrelease decisionとしてreviewする。
- GPU実行前に、同じ署名済みimage/runtime service accountのGPUなしbootstrap probeでWorker由来の
  allowlist JSON codeを確認する。edge 403/non-JSONまたはWorkers tail不達ならGPUを起動しない。

## Consequences

- Cloud Run machine clientはbrowser heuristicに依存せずapplication認証へ到達できる。
- 例外は5つのruntime POSTだけで、通常Web/API、未知path、GET、query付きrequestには適用されない。
- BICより強いruntime固有認証とattestationは維持されるが、BIC skip自体の構成driftとSecurity
  Eventsをrelease gateで監査する必要がある。
- source、deployment設定、WAF planが変わるため、candidate `810189b`のstaging evidenceは無効となる。
  新commit/new candidateとGPUなしlive preflightを先に完了し、追加GPU executionは別の明示承認を
  得るまで実行しない。

## Status

Accepted

## References

- [Cloudflare: Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)
- [Cloudflare: Available skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/)
- [Cloud Run one-shot runtime](../cloud-run-one-shot-runtime.md)
- [Cloud Run staging dark deployment](../cloud-run-staging-dark-deployment.md)
