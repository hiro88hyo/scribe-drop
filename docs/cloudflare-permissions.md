# Cloudflareの権限と資格情報

## 目的

Cloudflareの権限は、操作の途中で不足を発見してtokenを作り直すのではなく、使用するAPI、
Wrangler command、保存先を先に棚卸しして役割ごとに固定する。この文書を人間向けの正、
`tools/cloudflare-credential-policy.json`を機械可読な正とする。実account、domain、
resource ID、token値はどちらにも記録しない。

Cloudflare dashboardのtoken作成画面ではwrite権限が`Edit`と表示される。API referenceでは
同じpermission groupが`Write`と表記される場合がある。この文書では作成画面に合わせて
`Edit`を使う。

## API tokenの全役割

すべてのAPI tokenでAccount Resourcesは対象account 1件だけをIncludeする。Backend/Access
tokenのZone Resourcesはapplicationを公開するexact zone 1件だけをIncludeし、Pages tokenに
Zone Resourcesを追加しない。All accounts、All zones、IP address filteringを使わない。
GitHub-hosted runnerの送信元IPは固定されないため、CI tokenをIPで制限しない。

| 役割                         | 保存先                                                                                                                                    | Account permissions                                                                                                                          | Zone permissions                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Backend/Access control plane | GitHubの`staging`/`production` Environmentに別々の`CLOUDFLARE_API_TOKEN`。手動保守時だけ同じ環境のtokenをlocal credential storeへ一時注入 | `Access: Apps and Policies Edit`、`Access: Service Tokens Edit`、`D1 Edit`、`Queues Edit`、`Workers R2 Storage Edit`、`Workers Scripts Edit` | `Workers Routes Read`、`Zone Read`をexact application zoneだけ |
| Pages CI                     | GitHubの`staging`/`production` Environmentに別々の`CLOUDFLARE_PAGES_API_TOKEN`                                                            | `Cloudflare Pages Edit`だけ                                                                                                                  | なし                                                           |

`CLOUDFLARE_API_TOKEN`は、Access application/policy、Access service token、D1、Queues、
R2、Workersに必要な権限を最初からすべて持つ完成形とする。同じ環境・同じ用途のために
追加tokenを作成したり、操作の途中でAccessの`Read`を`Edit`へ変更したりしない。
`Edit`は同じresourceのread-backも許可するため、対応する`Read`を重ねない。

Pagesは[ADR 0042](./adr/0042-preflight-pages-upload-permission.md)のupload capability境界を
維持するため、既存の専用tokenから変更しない。Pages tokenはAccess、D1、Queues、R2、
Workersを操作せず、Backend/Access tokenはPagesを操作しない。この統合判断と影響範囲は
[ADR 0044](./adr/0044-consolidate-cloudflare-control-plane-token.md)と、そのZone権限訂正である
[ADR 0045](./adr/0045-preflight-wrangler-worker-route-capability.md)を正とする。

## 1回で設定するBackend/Access token

`CLOUDFLARE_API_TOKEN`を作成または置換するときは、次の8行を同じ作成画面で一度に設定する。
一部だけで作成して後から追加しない。

1. Account | Access: Apps and Policies | Edit
2. Account | Access: Service Tokens | Edit
3. Account | D1 | Edit
4. Account | Queues | Edit
5. Account | Workers R2 Storage | Edit
6. Account | Workers Scripts | Edit
7. Zone | Workers Routes | Read
8. Zone | Zone | Read

Account Resourcesは対象account 1件だけ、Zone Resourcesはapplicationを公開するexact zone
1件だけをIncludeする。stagingとproductionは資格情報の値を共有しないが、permission setは
常にこの8行で一致させる。

## 操作と必要permission

| 操作                                                                         | 使用資格情報   | 必要permission                                    |
| ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| Access application、policyの作成・更新・read-back                            | Backend/Access | `Access: Apps and Policies Edit`                  |
| Access service tokenの作成・更新・rotation・read-back                        | Backend/Access | `Access: Service Tokens Edit`                     |
| D1 migration適用、migration/query read-back                                  | Backend/Access | `D1 Edit`                                         |
| Queue、consumer、DLQの作成・更新・read-back                                  | Backend/Access | `Queues Edit`                                     |
| R2 CORS、lifecycle、Event Notificationの作成・更新・read-back                | Backend/Access | `Workers R2 Storage Edit`と`Queues Edit`          |
| Orchestrator deploy、secret、binding、Cron、Queue consumer、custom domain    | Backend/Access | `Workers Scripts Edit`とbinding先の上記permission |
| Wranglerがcustom domain deploy前に行うzone解決と既存route競合検査            | Backend/Access | exact zoneの`Zone Read`と`Workers Routes Read`    |
| Pages project/deployment/config/secretのread-back、upload capability、deploy | Pages CI       | `Cloudflare Pages Edit`                           |

固定Wrangler 4.114.0は、`custom_domain = true`でもupload後のtrigger処理で`GET /zones`と
`GET /zones/{zone_id}/workers/routes`を呼び、既存routeとの競合を検査してからaccount-level
Workers custom domain APIを呼ぶ。したがって`Zone Read`と`Workers Routes Read`はdeployの
必須権限である。custom domainのattachは`Workers Scripts Edit`で行うため、`DNS Edit`と
`Workers Routes Edit`は不要である。現在のworkflowはAnalytics GraphQL、`wrangler tail`、
Access audit log、Cloudflare API token管理APIを呼ばないため、それらの権限も不要である。

## API tokenではない資格情報

### R2 parent signer

WebがR2 Temporary Credentialsをlocal signingする親資格情報は、通常のCloudflare API
tokenとは別にR2のAPI Tokens画面で作成する。permissionは`Object Read & Write`、resourceは
environmentごとのexact bucket 1件だけにする。`Admin Read & Write`とAll bucketsは付けない。
stagingとproductionで別々に作成し、Access Key IDとSecret Access KeyをそれぞれのPages
projectの`R2_PARENT_ACCESS_KEY_ID`と`R2_PARENT_SECRET_ACCESS_KEY` secretへ保存する。

親資格情報をbrowser、RunPod、GitHub workflowへ渡さない。Webはexact object、短いTTL、
必要なmultipart actionだけを持つtemporary credentialを発行し、子credentialは親tokenの
権限を超えられない。

### Staging Access service principal

`CF_ACCESS_CLIENT_ID`と`CF_ACCESS_CLIENT_SECRET`はCloudflare API tokenではない。
staging custom-hostname applicationとPages Preview Access applicationの2件だけに、exact
service tokenを指定した`Service Auth` policyを1件ずつ置く。GitHub `staging` Environment
だけへ保存し、productionへ登録しない。

## 明示的に付けない権限

- `Account Settings Read/Edit`
- `API Tokens Read/Edit`
- `Account Analytics Read`とzone `Analytics Read`
- `Logs Read/Edit`と`Workers Tail Read`
- `DNS Read/Edit`、`Zone Edit`、`Workers Routes Edit`
- exact application zone以外の`Zone Read`と`Workers Routes Read`
- `Zero Trust Read/Edit`
- Pages以外のtokenに`Cloudflare Pages Read/Edit`
- R2 parent signerの`Admin Read & Write`またはAll buckets

新しいCloudflare API endpoint、Wrangler command、binding、domain方式を追加する場合は、
remote実行より先にこの文書、`tools/cloudflare-credential-policy.json`、対応testを同じ
変更で更新する。既存permissionで説明できない操作を、権限不足が出てからtokenへ追加しては
ならない。

## 検証

```bash
pnpm cloudflare:permissions:verify
pnpm ci:verify
```

Cloudflareのtoken verify APIはtoken ID、状態、有効期限を返すが、付与permission一覧を
返さない。そのためCIは、Backend/Access tokenの8権限からの欠落または追加、zone scope、
Backend/Pages tokenの役割混在、新しいCloudflare API callerとWrangler commandを静的検査
する。remote mutation前には`GET /zones`と`GET /zones/{zone_id}/workers/routes`を含む
実際のread-backとPages upload capability preflightで能力を確認する。token値、zone ID、
hostname、短期capabilityは出力しない。

権限名とAPI要件の確認先:

- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare Access service token rotation](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/rotate/)
- [Cloudflare Queue consumer API](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/create/)
- [Cloudflare Workers custom domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
- [Cloudflare R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
