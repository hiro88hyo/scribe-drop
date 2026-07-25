# Cloudflare Access

## 適用範囲

`SCRIBE_DROP_STAGING_WEB_ORIGIN`で指定するstaging Webの単一正規origin全体を
Cloudflare Accessで保護する。実originはCloudflareと追跡外設定だけに保持し、
repositoryやdeployment記録には保存しない。Accessを前段に置くだけでAPI認証済みとは
みなさず、Pages Functionsは
[ADR 0003](./adr/0003-access-jwt-and-csrf-boundary.md)に従って
`Cf-Access-Jwt-Assertion`を再検証する。

Access application、policy、identity provider、Pages secretが揃い、未認証preflightが
成功するまでWebをdeployしない。Pages custom domainを先に接続してactiveになったことを
確認し、その正規originをAccess applicationへ設定する。preview branchや別hostnameを
公開経路に追加する場合も、先にenvironment固有のAccess applicationとaudienceを用意する。

## Staging application

Zero Trust dashboardまたは必要な最小権限を持つCloudflare API tokenで、次のself-hosted
applicationを作成する。

| 項目                      | 値・制約                                        |
| ------------------------- | ----------------------------------------------- |
| Name                      | `scribe-drop-web-staging`                       |
| Domain                    | `SCRIBE_DROP_STAGING_WEB_ORIGIN`のhost          |
| Type                      | Self-hosted                                     |
| Session duration          | 24時間                                          |
| Allowed identity provider | staging用Google identity provider 1件だけ       |
| Auto redirect             | identity providerを1件に限定した場合だけ有効    |
| App Launcher              | 初期releaseでは非表示                           |
| iframe                    | 不許可                                          |
| Policy decision           | Allow                                           |
| Policy include            | 利用を許可するGoogleアカウントのexact emailだけ |

bypass、Everyone、メールdomain全体、service tokenだけのallow ruleは追加しない。許可emailは
Access policyにだけ保存し、repository、deployment記録、application logへ残さない。

application作成後、次の非secret値を取得する。

- team domainのexact origin:
  `https://<team>.cloudflareaccess.com`
- application固有のAUD tag

値は追跡対象ファイルへ直接書かず、設定生成時だけ次の環境変数で渡す。

- `SCRIBE_DROP_STAGING_WEB_ORIGIN`
- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`

## Pages secret

Webは次の4 secretを要求する。

- `CSRF_HMAC_SECRET`
- `OWNER_HASH_HMAC_SECRET`
- `R2_PARENT_ACCESS_KEY_ID`
- `R2_PARENT_SECRET_ACCESS_KEY`

HMAC secretはenvironment固有の32 byte以上の暗号学的乱数とする。R2親credentialは
`recording-transcriber-staging`だけに限定し、Temporary Credentialsのlocal signing
以外に使わない。値はチャット、shell引数、Git、logへ出さず、Wranglerの対話入力または
credential storeから登録する。

```bash
pnpm exec wrangler pages secret put CSRF_HMAC_SECRET \
  --project-name scribe-drop-web-staging
pnpm exec wrangler pages secret put OWNER_HASH_HMAC_SECRET \
  --project-name scribe-drop-web-staging
pnpm exec wrangler pages secret put R2_PARENT_ACCESS_KEY_ID \
  --project-name scribe-drop-web-staging
pnpm exec wrangler pages secret put R2_PARENT_SECRET_ACCESS_KEY \
  --project-name scribe-drop-web-staging
pnpm exec wrangler pages secret list \
  --project-name scribe-drop-web-staging
pnpm cloudflare:secrets:verify:staging
```

`secret list`では名前だけを確認し、値を取得しない。PagesのWrangler設定は必須secretを
宣言する構文を持たないため、deploy前に検証コマンドを実行し、4件の暗号化secret名が
揃わない場合はfail closedとする。

## 未認証preflight

設定生成後、rootと`/api/me`がorigin responseを返さず、期待するteam domainの
`/cdn-cgi/access/login/`へredirectすることを確認する。

```bash
pnpm cloudflare:config:staging:web
pnpm cloudflare:access:verify:staging
```

検証コマンドは`SCRIBE_DROP_STAGING_WEB_ORIGIN`と
`SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`を必要とし、次の場合にfail closedとする。

- 2xx、401、403、404などAccess login redirect以外を返す。
- `Location`が欠落している。
- redirect先originが期待するteam domainと異なる。
- redirect先pathがAccess login endpointではない。

未認証preflight成功後にだけ、[deployment.md](./deployment.md)のPages deployを実行する。

## Deploy後の確認

1. 未認証のprivate windowでrootと`/api/me`がAccess loginへ遷移する。
2. allowlistされたGoogleアカウントでloginできる。
3. allowlist外アカウントはapplicationへ到達できない。
4. 認証後の`GET /api/me`が200となり、CSRF tokenを返す。
5. 別applicationのaudienceを持つJWT、JWTなし、不正issuerはAPIで401になる。
6. response、browser storage、Cloudflare logにJWT、email、CSRF tokenが残らない。

Access session確認用のscreenshot、HAR、JWTをartifactやticketへ保存しない。問題調査では
request IDと安全なstatusだけを記録する。

## CLI権限

WranglerのPages権限とAccess API権限は別である。AccessをAPIで管理する場合は、
application/policyには`Access: Apps and Policies Write`、organization/IdPの読み取りには
`Access: Organizations, Identity Providers, and Groups Read`を持つenvironment専用tokenを
使う。tokenをWrangler OAuth credentialから抽出して再利用せず、secret managerから
短時間の作業環境へ注入する。
