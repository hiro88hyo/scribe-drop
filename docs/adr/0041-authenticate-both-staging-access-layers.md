# ADR 0041: stagingの二重Access層を個別に認証する

## Context

stagingのcustom Web originは、custom hostnameを対象とするself-hosted Access applicationで
保護されている。Cloudflare PagesのPreview Accessも有効であり、custom hostnameへの
requestはoriginへ到達する前にPagesの`*.pages.dev` applicationでも評価される。

Access audit logではService Tokenを提示したrequestが成功していたが、responseは別の
Access loginへredirectされた。redirectのAUDをAccess application一覧と照合した結果、
外側のcustom hostname applicationは標準の`CF-Access-Client-Id`と
`CF-Access-Client-Secret`を受理しており、redirectは内側のPages applicationが生成して
いた。外側のAccessが標準headerを消費するため、同じheaderだけでは内側へService Tokenを
提示できない。

内側のPages applicationへService Auth policyを追加するだけではredirectは解消しなかった。
内側だけに`read_service_tokens_from_header = Authorization`を設定し、exact service tokenを
許可するService Auth policyを置いた上で、外側用の標準2 headerと内側用のJSON
`Authorization`を同時に送ると、rootはAccessを通過した。その時originへ届くAccess JWTの
AUDは内側のPages applicationであるため、外側のAUDだけを許可していたWeb runtimeは
`GET /api/me`を401で拒否した。

## Decision

- Preview Accessを有効にしたstaging Webは、外側のcustom hostname applicationと内側の
  Pages applicationの二重Access境界として扱う。
- 外側のapplicationは標準の`CF-Access-Client-Id`と`CF-Access-Client-Secret`を読む。
  内側のPages applicationは`Authorization`からService Tokenを読むよう構成し、同じ
  staging CI専用Service Tokenをexact selectorで許可するService Auth policyを持つ。
- 内側用`Authorization`は次のJSON objectを文字列化した値とする。
  fieldを増やさず、Client ID/secretを入れ替えず、Bearer形式へ変換しない。

  ```json
  {
    "cf-access-client-id": "<client-id>",
    "cf-access-client-secret": "<client-secret>"
  }
  ```

- CIのread-only verifierとPlaywrightは、exact staging Web originへの全requestだけに
  標準2 headerと上記Access JSON `Authorization`を同時送信する。cookie取得後も両方を
  継続する。Playwright route自体を`${appOrigin}/**`だけに登録し、callback内でもoriginを
  再検証してからcredentialを付与する。Access team domain、R2、download先、その他の
  originはこのadapterを通さず、browserが生成したheaderを変更しない。
- Playwrightの`route.fetch()`をexact application originへ使う際、Chromiumが生成した
  `Sec-Fetch-Site`がrequest headersに存在しないことがある。unsafe method、exact
  `Origin`一致、header欠落の3条件をすべて満たす場合だけ`same-origin`を補完する。
  cross-origin、`Origin`不一致、既存のFetch Metadataは補正しない。
- Web runtimeの`ACCESS_AUDIENCES`には、外側AUDと内側Pages AUDの2件を含める。
  `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`と
  `SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE`を別々に検証し、欠落、不正形式、重複を
  fail closedとする。
- staging preflightはrootと`GET /api/me`がredirectなしで2xxとなること、期待するservice
  principal cookie、API固有security headerをremote mutation前に検証する。Access login
  redirectはcookieの有無にかかわらず二重認証の不成立として拒否する。
- control-plane read-backでは、2つのapplication、内側のService Auth policy、
  `Authorization` header設定、両AUDを確認する。dashboardだけの未記録変更に依存しない。
- productionへstaging AUDやService Token policyを追加しない。productionが将来同じ
  二重境界を採用する場合は、production固有の脅威分析とADRを先に追加する。
- Client ID、Client Secret、cookie、JWT、実AUD、実domain、application ID、policy IDを
  追跡対象ファイル、log、artifactへ残さない。

この決定は、単一Access applicationを前提にcookie bootstrapを原因とした
[ADR 0039](./0039-use-browser-scoped-access-handshake.md)を置き換える。
[ADR 0030](./0030-scope-access-service-credentials-to-app-origin.md)のexact-origin制限と
継続送信は維持し、内側Access用headerを追加する。

## Consequences

- 外側の認証成功を二重Access全体の成功と誤認せず、GPU待ちやdeployより前に内側policy、
  header方式、runtime AUDのdriftを検出できる。
- staging runtimeは環境固有の2 AUDを信頼する。どちらもAccess JWTの署名、issuer、claim、
  staging-only service principal検証を迂回しない。
- genericな`Authorization`をE2E routeが上書きするため、この機械認証browser contextを
  別のBearer認証試験へ流用しない。route scope外のR2 SigV4やartifact download requestは
  adapterが解釈、除去、再構築しない。
- E2E routeのrequest再送はbrowser security metadataを暗黙に再構築しない。mutationの
  回帰testではOrigin、CSRF、Fetch Metadataを個別に検証する。
- Pages Preview Accessを無効化または構成変更する場合は、2 AUDと二重headerを惰性で残さず、
  control-plane read-back、test、文書を同じ変更で更新する。

## Status

Accepted

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [ADR 0039: browser-scoped requestでAccess handshakeを行う](./0039-use-browser-scoped-access-handshake.md)
- [ADR 0040: staging service authをremote mutation前に検証する](./0040-verify-staging-service-auth-before-mutation.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
