# Cloudflare Access

## 適用範囲

`SCRIBE_DROP_STAGING_WEB_ORIGIN`または`SCRIBE_DROP_PRODUCTION_WEB_ORIGIN`で指定する
environment別Webの単一正規origin全体をCloudflare Accessで保護する。実originは
Cloudflareと追跡外設定だけに保持し、
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

ADR 0024のstaging自動E2Eを有効にする場合は、人間向けAllow policyとは別に、
CI専用service token 1件へ完全一致する`Service Auth` policyを追加する。service tokenを
通常のAllow policyへ入れず、ほかのservice tokenや`Any valid service token`へ広げない。
Client ID/secretはGitHub staging Environmentにだけ保存し、Client IDと同じJWT
`common_name`を`SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`へ設定する。
production applicationにはこのpolicyと変数を追加しない。

Pages Preview Accessを有効にしたstagingでは、custom hostname applicationの背後にPages
applicationがあるため、[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)の
二重境界として構成する。両applicationへ同じCI専用tokenだけを許可する`Service Auth`
policyを1件ずつ置く。custom hostname applicationは標準2 headerのままとし、Pages
applicationだけを`Authorization`からService Tokenを読む設定にする。`Any valid service
token`、複数の`Service Auth` policy、Pages側の標準header設定を許可しない。

API tokenと非secret変数を一時environmentから渡し、次のread-only検査で2 application、
相異なるAUD、layer固有header、exact policyを確認する。実ID、AUD、domain、token値は
出力しない。

```bash
pnpm cloudflare:access:control-plane:verify:staging
```

CIは[ADR 0040](./adr/0040-verify-staging-service-auth-before-mutation.md)に従い、remote
mutation前にread-only Service Auth verifierでapplication cookieと`GET /api/me`を確認する。
その後のbrowser acceptanceは
[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)に従う。exact staging Web
originだけへ、外側custom hostname Access用の標準2 headerと、内側Pages Preview Access用の
JSON `Authorization`を同時送信する。cookie取得後も3 headerを継続する。Access team
domain、R2、artifact download先、その他のoriginはPlaywright routeの対象外とし、adapterが
headerを解釈、除去、再構築しない。callback内でもoriginを再検証してからcredentialを
付与する。現在のpage originが正規originであることを確認し、`/api/me`は相対URLではなく
正規originから組み立てた絶対URLで確認する。

Playwrightの`route.fetch()`はChromiumのFetch Metadataを常に再構築するとは限らない。
unsafe methodのexact application requestで、`Origin`が正規originと一致し、
`Sec-Fetch-Site`だけが欠落している場合に限り`same-origin`を補完する。Origin不一致、
cross-origin、既存headerは補正しない。exact-origin route、callback内origin guard、
Fetch Metadata条件はunit testと静的CI検査で固定する。実staging acceptanceはjob作成の
201とmultipart actionの成否を直後に判定してからGPU待ちへ進む。

application作成後、次の非secret値を取得する。

- team domainのexact origin:
  `https://<team>.cloudflareaccess.com`
- custom hostname Access application固有のAUD tag
- Pages Preview Access application固有のAUD tag

値は追跡対象ファイルへ直接書かず、設定生成時だけ次の環境変数で渡す。

- `SCRIBE_DROP_STAGING_WEB_ORIGIN`
- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`
- `SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE`
- `SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`

productionは別のself-hosted applicationとして作成し、Nameを
`scribe-drop-web-production`、Domainを`SCRIBE_DROP_PRODUCTION_WEB_ORIGIN`のhostとする。
policy、AUD、HMAC secret、R2 credentialをstagingと共有しない。次のproduction専用変数で
追跡外設定を生成する。

- `SCRIBE_DROP_PRODUCTION_WEB_ORIGIN`
- `SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE`

production applicationでもGoogle identity provider 1件、exact email allowlist、
24時間session、iframe不許可、App Launcher非表示を維持する。bypass、Everyone、
メールdomain全体を追加しない。

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

productionでは同じ4 secretを`scribe-drop-web-production`へ別値で登録し、
`pnpm cloudflare:secrets:verify:production:pages`で名前だけを検証する。production親R2
credentialはproduction bucketだけへ限定し、staging credentialを登録しない。

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

productionでは次を使用し、verifierはproduction origin/team domainに`staging` markerが
ある場合と、redirect先がproduction team domain以外の場合にfail closedとする。

```bash
pnpm cloudflare:config:production:web
pnpm cloudflare:access:verify:production
```

## Staging Service Auth preflight

未認証Access境界の確認とは別に、CI専用Service Tokenがrootと`/api/me`へ到達できることを
確認する。Client ID/secretはGitHub staging Environmentまたは一時credential storeから
環境変数で渡し、shell引数や追跡対象ファイルへ書かない。

```bash
pnpm cloudflare:access:service:verify:staging
```

このコマンドは次をすべて確認する。

- Client IDと期待する`common_name`が完全一致し、Client Secretを含め形式が正しい。
- 外側用標準2 headerと内側用JSON `Authorization`をexact staging Web originへだけ送り、
  cookie取得後も継続する。
- redirectを自動追跡せず、同一originだけを上限付きで追跡する。
- cookieの有無にかかわらずAccess team login redirectとその他のcross-origin redirectを
  認証成功とせず、3つのcredential headerも送らない。
- application domainの`CF_Authorization` cookieが期待するservice principalを表す。
- 同じsessionで`GET /api/me`が2xxとなり、API固有の`application/json`、`no-store`、
  `nosniff`を返す。

response本文、Client ID/secret、cookie、JWT、redirect URLは出力しない。local probeが
成功するまでpromotion workflowを起動せず、staging workflowでもdependency install直後、
control-plane read-back、candidate download、RunPod CLI install、すべてのremote mutation
より前に同じコマンドを実行する。このpreflightはdeploy後browser acceptanceを代替しない。

## Deploy後の確認

1. 未認証のprivate windowでrootと`/api/me`がAccess loginへ遷移する。
2. allowlistされたGoogleアカウントでloginできる。
3. allowlist外アカウントはapplicationへ到達できない。
4. 認証後の`GET /api/me`が200となり、CSRF tokenを返す。
5. 別applicationのaudienceを持つJWT、JWTなし、不正issuerはAPIで401になる。
6. response、browser storage、Cloudflare logにJWT、email、CSRF tokenが残らない。
7. stagingではCI専用service tokenがcookieを取得でき、別service tokenはWebのJWT再検証で
   401になる。CIはcookie claim一致と認証済み`GET /api/me`をupload前に確認し、
   productionではservice token principalを受け入れない。

Access session確認用のscreenshot、HAR、JWTをartifactやticketへ保存しない。問題調査では
request IDと安全なstatusだけを記録する。

## CLI権限

WranglerのPages権限とAccess API権限は別である。AccessをAPIで管理する場合は、
application/policyには`Access: Apps and Policies Write`、organization/IdPの読み取りには
`Access: Organizations, Identity Providers, and Groups Read`を持つenvironment専用tokenを
使う。tokenをWrangler OAuth credentialから抽出して再利用せず、secret managerから
短時間の作業環境へ注入する。

Service Tokenの存在、Client ID、有効期限、policy参照をread-backする診断には
`Access: Service Tokens Read`、rotationには`Access: Service Tokens Write`だけを追加する。
rotationは自動test済みのprobeを用意してから一度だけ行い、新secretをlocalで検証して
GitHub staging Environmentを更新する。調査終了後は不要なWrite権限を除去する。
