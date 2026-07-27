# ADR 0033: Pagesのdata-plane収束後にstaging E2Eを開始する

## Context

staging promotionはPages APIで最新candidate deploymentと設定hashを確認した直後に、
custom domain上の実browser E2Eを開始していた。Pagesのcontrol planeでは新deploymentが
activeでも、custom domainのedgeが短時間だけ直前のbundleを返す場合がある。実際に
read-back成功直後の`GET /api/me`が旧bundleの404となり、candidateの機能不良ではないのに
長時間workflow全体が失敗した。

workflow全体を無条件に再実行すると、既に完了したD1、R2、RunPod、Pages mutationまで
繰り返す。逆に固定sleepでは、不要に遅く、収束を証明できず、恒久的な404も見逃す。

## Decision

- control-plane read-back成功後、実browserから同一originの`GET /api/me`を認証cookie付き、
  `no-store`で取得し、data-plane readiness probeとする。
- probeは1秒、2秒、5秒、10秒間隔を上限内で繰り返し、最大2分で停止する。
- HTTP 200だけでなく、schema上のuser emailがstaging専用の固定E2E identityと一致する
  ことを要求する。Access迂回、別environment、旧bundle、未認証応答をreadyとしない。
- readinessが成立してからmedia upload、RunPod処理、artifact download、deleteの
  lifecycleを開始する。
- probeはGETだけを使用する。uploadやほかのmutationを自動再試行しない。
- timeout時は最後のstatusと安全な期待値差分だけを残し、response body、JWT、cookie、
  credential、実resource IDを出力しない。

## Consequences

- Pages edgeの短時間の反映差で、staging workflow全体を手動再実行する頻度を下げられる。
- 恒久的なroute、Access、binding、identity不良は2分以内にfail closedとなる。
- staging E2E開始まで最大2分増える可能性があるが、高コストなRunPod jobを誤った
  data-planeに対して開始しない。

## Status

Accepted

## References

- [ADR 0029: Pages configはapp rootから検出する](./0029-discover-pages-config-from-app-root.md)
- [ADR 0030: Access service credentialを正規app originへ限定する](./0030-scope-access-service-credentials-to-app-origin.md)
