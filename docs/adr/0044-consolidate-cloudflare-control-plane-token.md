# ADR 0044: Cloudflare BackendとAccessの制御面tokenを統合する

## Context

Staging/production promotionは、Access applicationとservice tokenのread-back、D1 migration、
QueuesとDLQ、R2 CORS/lifecycle/Event Notification、Workers deployとcustom domainを操作する。
Access service tokenの保守では、同じAccess resourceに対する作成、policy更新、rotationも
必要になる。

Accessのread-only CI tokenとlocal-only管理tokenを分離すると権限は狭くなるが、同じ環境の
制御面操作に複数tokenの作成、保管、選択が必要になる。実際の運用では、操作開始後に不足
permissionが判明し、Cloudflare token作成を繰り返す原因になった。一方、Pages upload
capabilityは[ADR 0042](./0042-preflight-pages-upload-permission.md)で独立した権限境界として
確立している。

## Decision

環境別の`CLOUDFLARE_API_TOKEN`をBackend/Access制御面の単一tokenとし、作成時に次の6つの
Account permissionを一度に設定する。

1. `Access: Apps and Policies Edit`
2. `Access: Service Tokens Edit`
3. `D1 Edit`
4. `Queues Edit`
5. `Workers R2 Storage Edit`
6. `Workers Scripts Edit`
   Account Resourcesは対象account 1件だけをIncludeし、Zone permission、Pages permission、
   Analytics、Logs、Account Settings、API Tokens permissionは付けない。Accessの`Edit`が
   read-backを含むため、対応する`Read`は追加しない。

Stagingとproductionのtoken値は共有しない。GitHub Environmentに保存した対象環境のtokenを
通常promotionで使い、Access保守時だけ同じtokenをlocal credential storeへ一時注入する。
Access専用の追加API tokenは作らない。

`CLOUDFLARE_PAGES_API_TOKEN`は`Cloudflare Pages Edit`だけを持つ既存の専用tokenとして
分離を維持する。R2 parent signerとstaging Access service principalもAPI tokenとは別の
資格情報として維持する。

機械可読なexact permission setを`tools/cloudflare-credential-policy.json`に固定する。
CIは6権限の欠落・追加、zone permission、新しいCloudflare API caller、新しいWrangler
product commandを拒否する。新しい操作に別permissionが必要な場合は、remote実行より先に
このADRの置換または追補、権限表、policy、testを更新する。

## Consequences

- Backend/Access tokenは1回の作成で、現在のbootstrap、deploy、read-back、Access保守、
  service token rotationをすべて実行できる。
- 同じ用途のために権限を後付けしたり、追加のAccess管理tokenを作成したりしない。
- Account-level Access EditをGitHub Environmentへ置くため、read-only tokenより侵害時の
  影響範囲が広がる。対象account限定、environment別token、GitHub Environment保護、
  Pages/Zone権限の除外、secret scanで緩和する。
- Cloudflare API token permissionは個別Access applicationへ絞れないため、staging token
  でも同じaccount内のAccess resourceを変更できる。この制約を理由にstaging/productionの
  token値を共有しない。
- Pages、R2 S3、Access service principalの資格情報分離は変更しない。

## Status

Superseded by [ADR 0045](./0045-preflight-wrangler-worker-route-capability.md)
