# ADR 0003: Access JWTとCSRFの認証境界を固定する

- Status: Accepted
- Date: 2026-07-25

## Context

ScribeDropはCloudflare Accessでサイト全体を保護するが、前段のAccess判定だけをAPI認証の根拠にはしない。`/api/*`では署名済みAccess JWTを再検証し、状態変更ではAccess cookieが自動送信されることを前提にCSRFも防ぐ必要がある。

Cloudflareはoriginへ`Cf-Access-Jwt-Assertion` headerでapplication tokenを渡し、cookieよりheaderの検証を推奨している。署名鍵はteam domainの`/cdn-cgi/access/certs`から取得でき、通常6週間ごとにrotationされ、直前の鍵も7日間公開される。一方、Access前段のWorkersではCache APIが利用できないため、JWKSを`caches.default`へ保存する設計は使えない。

## Decision

### Access JWT

- `apps/web/functions/api/_middleware.ts`を`/api/*`共通境界とし、静的assetや画面routeへAPI middlewareを広げない。
- JWTは`Cf-Access-Jwt-Assertion` headerだけから取得する。`CF_Authorization` cookie、query、bodyからは取得しない。
- `jose`の`jwtVerify`と`createRemoteJWKSet`を使い、検証器をCloudflare adapterに閉じ込める。
- `ACCESS_TEAM_DOMAIN`はpath、query、fragment、userinfoを持たない`https://<team>.cloudflareaccess.com`だけを許可し、正規化後の完全一致をissuer検証に使う。
- `ACCESS_AUDIENCES`は環境別の1件以上のAUD tagをJSON配列で与える。空要素、重複、未知fieldを拒否し、stagingとproductionで共有しない。
- 署名algorithmは`RS256`だけを許可する。
- issuer、audience、expiration、issued-at、subject、emailを必須にする。`nbf`がある場合も検証し、clock toleranceは30秒とする。
- 署名検証後に`sub`を1～512文字、`email`を妥当なメール形式かつ最大320文字として再検証する。所有者IDには`sub`だけを使い、emailは表示・監査用途に限定する。
- middlewareから後段へ渡す認証contextは`{ sub, email }`だけとし、JWT原文、全payload、署名、headerを渡さない。
- JWTなし・署名不正・claim不正・期限切れは同じ`401 UNAUTHENTICATED`応答に正規化する。検証libraryのerror本文は応答にもapplication logにも含めない。
- JWKS取得timeoutなど、tokenの正否を判定できない依存障害はfail closedとし、安全な`500 INTERNAL_ERROR`を返す。直前tokenを未検証で許可しない。

### JWKS cacheとrotation

- `createRemoteJWKSet`はmodule scopeでteam domainごとに1個だけ生成し、isolate内のmemory cacheを再利用する。
- `cacheMaxAge`は10分、`cooldownDuration`は30秒、`timeoutDuration`は5秒とする。
- JWKS endpointの`keys`を使い、単一の`public_cert`やrepositoryへ保存した公開鍵を使わない。
- 未知の`kid`ではremote JWKSを再取得できるようにしつつ、cooldown中の連続fetchを抑止する。
- Cache API、D1、KVへJWKSを複製しない。cold start後の最初の検証ではremote取得が発生し得る。
- unit testではremote通信を行わず、固定時刻、生成したtest key、注入したkey resolverを使う。rotation integration testでは旧鍵と新鍵を同時に含むJWKS fixtureを使う。
- `DISABLE_AUTH`や固定利用者を返すruntime分岐は作らない。local automated testでは検証器を注入し、interactiveな実Access結合確認はstagingで行う。

### CSRFとrequest metadata

- `GET /api/me`がCSRF tokenをJSON bodyで返す。tokenをcookie、URL、localStorage、logへ保存しない。frontendはmemoryだけに保持し、期限切れ時は`/api/me`から再取得する。
- tokenは`v1.<issued-at>.<expires-at>.<128-bit nonce>.<HMAC-SHA-256 signature>`形式とする。時刻はUnix秒、binary値はpaddingなしbase64urlで表現する。
- HMAC入力へversion、issued-at、expires-at、nonce、検証済み`sub`、正規originを長さ付きで含める。これによりtokenを利用者とenvironment originへ結び付ける。
- `CSRF_HMAC_SECRET`はsecret managerから渡す32 byte以上のrandom secretとする。signature検証にはWeb CryptoのHMAC verifyを使い、文字列の通常比較を使わない。
- token TTLは15分、clock toleranceは30秒とする。未来のissued-at、TTL超過、形式不正、署名不正を拒否する。
- `POST`、`PUT`、`PATCH`、`DELETE`では、JWT検証後に次をすべて要求する。
  - `Origin`が`ALLOWED_ORIGIN`とscheme、host、portを含め完全一致する。
  - `Sec-Fetch-Site`が`same-origin`である。欠落、`same-site`、`cross-site`、`none`は拒否する。
  - media typeが`application/json`である。大文字小文字と任意の`charset` parameterは正規化するが、`text/plain`やform encodingは拒否する。
  - `X-CSRF-Token`が現在のAccess `sub`に対して有効である。
- APIではcredential付きCORSを提供せず、wildcard originやsubdomain wildcardを許可しない。cross-origin preflightを成功させるheaderも返さない。
- `GET`と`HEAD`は状態を変更せず、CSRF tokenを要求しない。state changeをsafe methodへ追加しない。

### Middleware順序と応答

1. server生成のrequest IDを割り当てる。client指定IDを信頼しない。
2. environmentをschema検証する。
3. Access JWTを検証し、最小auth contextを作る。
4. unsafe methodではOrigin、Fetch Metadata、Content-Type、CSRFを検証する。
5. route handlerを実行する。
6. 例外を安全なAPI errorへ正規化し、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Request-ID`を付ける。

所有権不一致はresourceの存在を開示しない`404 NOT_FOUND`とする。repository query自体へ`owner_sub = ?`と`deleted_at IS NULL`を含め、取得後だけの判定に依存しない。

## Consequences

- Access設定の誤りや`*.pages.dev`経由の直接到達があっても、有効なissuerとaudienceを持つJWTがなければAPIへ到達できない。
- key rotationへ追従でき、未知`kid`を使ったJWKS fetch増幅もcooldownで抑制できる。
- Access前段やcookieのCSRF耐性だけに依存せず、Origin、Fetch Metadata、JSON、利用者bound tokenの多層防御になる。
- `Sec-Fetch-Site`を送らないlegacy browserや非browser clientはstate-changing APIを利用できない。対象はprivateなmodern browser appであるためfail closedを選ぶ。
- XSSが成立した場合、memory上のCSRF tokenを利用できるため、CSRF対策はXSS対策の代替ではない。CSP、Reactの安全な描画、dependency管理を別途維持する。
- rate limit方式とfail-open/fail-closed方針は後続の[ADR 0004](./0004-d1-job-admission-control.md)で決定済みである。

## References

- [Cloudflare: Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Pages: Middleware](https://developers.cloudflare.com/pages/functions/middleware/)
- [Cloudflare Workers: Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [OWASP: Cross-Site Request Forgery Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [MDN: Sec-Fetch-Site](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site)
- [jose: Remote JWKS](https://jsr.io/@panva/jose/doc/jwks/remote)
