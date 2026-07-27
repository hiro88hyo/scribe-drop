# ADR 0024: stagingだけでAccess service principalを受け入れる

## Context

ADR 0023のstaging acceptanceは、固定dummy mediaを実browserからR2、Queue、RunPodへ
通す必要がある。Cloudflare Accessのemail OTPは対話操作と短期cookieを必要とし、
再現可能なCI認証には使えない。一方、Access service tokenのapplication JWTは人間の
JWTと異なり`email`を持たず、`type=app`、Client IDを示す`common_name`、空文字の`sub`で
service principalを表す。

service token headerをPlaywright contextへ常設すると、cross-originのR2 presigned requestにも
転送され、CORSや署名境界を壊す可能性がある。service principalをproductionでも受理したり、
任意のservice tokenを一律に利用者へ変換したりすると、通常の人間向け認証境界を広げる。

## Decision

- staging Access applicationに、CI専用service tokenへ完全一致する`Service Auth` policyを
  追加する。人間向けAllow policyは別policyとして維持する。
- Webは`APP_ENV=staging`で、かつ
  `STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`とJWTの`common_name`が完全一致し、
  `type=app`かつ`sub`が空文字である場合だけservice principalを受け入れる。issuer、AUD、
  RS256署名、時刻は人間のJWTと同じ検証を行う。
- service principalの表示用emailは固定の予約済みdummy addressとし、所有権、CSRF、
  D1 queryには`common_name`原文ではなく、domain separationしたSHA-256から生成する固定の
  疑似subjectを使用する。service token名、Client ID原文、credentialをlogへ出さない。
- production configはservice principal設定を持たず、設定しようとした場合は起動境界で
  拒否する。
- Playwrightのservice token transportは
  [ADR 0030](./0030-scope-access-service-credentials-to-app-origin.md)に従う。正規のstaging
  Web originへだけ継続送信し、redirectとR2 multipartを含むcross-origin requestへ
  service token headerを送らない。
- staging実E2Eではtrace、screenshot、videoを無効にし、Access credential、cookie、
  temporary R2 credential、成果物本文をCI artifactへ保存しない。
- service token ID/secretはGitHubのstaging Environment secretに限定し、production
  Environment、candidate artifact、repositoryへ渡さない。

Accessが期待するcookieまたはservice JWT claimを返さない場合はstaging acceptanceを失敗
させる。claimを推測して許容したり、email検証を全利用者について緩めたりしない。

## Consequences

- 対話OTPなしで同じcandidateの実service E2Eを再実行できる。
- stagingに専用Access policyとservice tokenのrotation運用が必要になる。
- 同じapplication artifactをproductionへ昇格しても、productionでは環境設定がないため
  service principal経路は認証されない。
- Accessのservice-token claim仕様が変わるとacceptanceがfail closedとなる。その場合は
  official仕様とstaging実測を確認し、このADRと回帰testを更新する。

## References

- [Cloudflare Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## Status

Accepted（credential transportはADR 0030で改訂）
