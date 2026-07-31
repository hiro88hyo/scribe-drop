# ADR 0045: WranglerのWorker route読取り権限をmutation前に検証する

## Context

[ADR 0044](./0044-consolidate-cloudflare-control-plane-token.md)は、Backend/Access tokenを
6つのAccount permissionへ固定し、Zone permissionを不要と判断した。この判断は誤りだった。

固定Wrangler 4.114.0は、Orchestratorの`custom_domain = true` deployでもWorker upload後に
`GET /zones`でzoneを解決し、`GET /zones/{zone_id}/workers/routes`で既存routeとの競合を
検査してからaccount-level custom domain APIを呼ぶ。2026-07-28のstaging promotionでは、
以前の手動診断で判明していたこの要件を追跡文書へ反映しなかったため、新token作成時に
権限が回帰した。preflightはAccess、Pages、D1、R2、Queues、Workers Scriptsを検査したが、
Wranglerが内部で呼ぶzone APIを検査せず、Pages、D1、R2、RunPod、Worker uploadの後に
認証失敗した。

## Decision

環境別`CLOUDFLARE_API_TOKEN`の完成形を、ADR 0044の6つのAccount permissionに次の2つの
Zone permissionを加えた8権限とする。

1. `Workers Routes Read`
2. `Zone Read`

Zone Resourcesはapplicationを公開するexact zone 1件だけをIncludeする。`DNS Edit`、
`Zone Edit`、`Workers Routes Edit`は付けない。Custom Domainのattachはaccount-level
`Workers Scripts Edit`で行い、Zone permissionは固定Wranglerのzone解決と既存routeの
read-only競合検査だけに使う。

Stagingとproductionのworkflowは、D1、R2、RunPod、Worker、Pagesの最初のmutationより前に
実credentialで`GET /zones`と`GET /zones/{zone_id}/workers/routes`を呼ぶ。zoneが対象accountの
activeなexact zone 1件へ解決され、route一覧が取得できる場合だけdeployを許可する。
preflightはtoken、hostname、zone ID、route内容を出力しない。

権限表、機械policy、preflight実装、mock test、workflow順序testを同じ変更で更新する。
Wrangler versionを更新する場合は、固定bundleのdeploy経路と実APIを再監査してからpermission
setを変更する。

## Consequences

- 既知のWrangler route read権限不足をremote mutation前に検出できる。
- Backend/Access tokenはexact application zoneの名前とWorker routeを読み取れるが、
  zoneやrouteを書き換えられない。
- Account permission 6つ、Zone permission 2つ、Account Resources 1件、Zone Resources
  1件をstaging/productionで同じ形に設定する。
- Dashboardだけで追加した権限を追跡漏れさせず、CIが8権限からの欠落と追加を拒否する。

## Status

Accepted
