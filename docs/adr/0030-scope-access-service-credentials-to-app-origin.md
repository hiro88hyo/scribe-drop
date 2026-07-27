# ADR 0030: Access service credentialをapplication originへ限定して継続送信する

## Context

[ADR 0024](./0024-staging-only-access-service-principal.md)は、Playwrightが最初のAccess
認証でservice token headerを送り、`CF_Authorization` cookie取得後はheaderを削除する
設計にしていた。これはcross-originのR2 presigned requestへcredentialを転送しないため
だった。

staging acceptanceではcookieを取得できたが、header削除後のapplication再読込で
認証済み`/api/me`を確認できず、media uploadより前に失敗した。Cloudflare Accessは
Service Auth policyだけを使うrequestではservice tokenを後続requestにも要求し、
applicationにAllow policyがある場合だけcookie単独の利用を保証する。CI認証の成立を
人間向けpolicyの有無や評価方法へ暗黙に依存させるべきではない。

一方、browser context全体へservice token headerを設定すると、R2 uploadや将来追加する
cross-origin requestへcredentialが漏れる。redirect時に追加headerを自動継承する実装も
同じ問題を持つ。

## Decision

- staging Playwrightはservice token credentialをbrowser contextの既定headerへ設定しない。
- 全requestをoriginで判定し、正規のstaging Web originと完全一致するrequestだけへ
  `CF-Access-Client-Id`と`CF-Access-Client-Secret`を付与する。
- application requestはredirectを自動追跡せず一度browserへ返す。redirect先は新しい
  requestとして再度origin判定し、cross-originへcredentialを継承しない。
- app origin以外のrequestからAccess credential headerを明示的に除去する。R2 presigned
  URL、Access team domain、download先をallowlistへ追加しない。
- 最初の応答では`CF_Authorization` cookieのservice-token claim形状と期待Client IDを
  値を出力せず比較する。再読込後はmedia uploadより前に同一originの`GET /api/me`が
  200と固定dummy identityを返すことを確認する。
- Pages deploy後のresource read-backでは、Pages project APIが返すproduction
  `wrangler_config_hash`を、生成した追跡外configのSHA-256と照合する。commitだけが一致
  しても環境変数とbindingの設定証跡とはみなさない。
- trace、screenshot、video、JWT、cookie、credential、API response本文はartifactへ
  保存しない。失敗時は安全なstatusと一致・不一致だけを報告する。

この決定はADR 0024の「最初の認証後に追加headerを削除する」というtransport部分だけを
置き換える。staging限定principal、JWT署名・issuer・AUD・claim検証、productionでの拒否は
維持する。

## Consequences

- Service Authのpolicy構成にかかわらず、staging CIの同一origin requestは継続して認証
  できる。
- Access credentialを必要としないR2や他originへsecret headerを送らない。
- Access claim、Pages config、`/api/me`のどこで失敗したかをmedia uploadやGPU待ちより
  前に区別できる。
- request interceptionがredirect、download、streamの挙動へ影響し得るため、local testと
  実staging lifecycleの両方を維持する。

## Status

Accepted

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0029: Pages設定をapp rootから検出してmutation前に検証する](./0029-discover-pages-config-from-app-root.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Wrangler configuration redirects](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)
