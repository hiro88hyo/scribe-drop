# ADR 0090: controllerのOpenSSL QUIC scan例外を非該当packageへ限定する

- Status: Accepted
- Date: 2026-08-20
- Target release: `0.2.0`
- Relates to: ADR 0068、ADR 0080、ADR 0086

## Context

処理時間をstaging acceptanceで必須化したrelease candidateのcontroller image buildで、固定Trivy DBが
distroless Debian 13の`libssl3t64 3.5.6-1~deb13u2`にHIGHの`CVE-2026-14456`を検出した。Debianは修正版を
未提供で、2026-08-20時点の公式`nodejs24-debian13:nonroot-amd64`最新digestにも同じpackageが含まれる。
Node 24をDebian 12へ移す公式distroless tagはなく、base digestの更新だけでは検出結果が変わらない。

このCVEはOpenSSL 3.5以降のQUIC server Listenerが未検証Initial packetからpending channelを無制限に保持する
denial-of-serviceである。controllerはNodeのTCP HTTP serverだけをCloud Run ingressの背後で実行し、UDP socketも
OpenSSL QUIC Listenerも作らない。imageから抽出したNode executableのdynamic dependencyに`libssl`はなく、offline
container processのshared object reportにもOSの`libssl`はない。一方、CVE番号全体を無条件に除外すると、package、
image、利用経路が変化した場合の検出まで失う。

参照:

- [OpenSSL security advisories](https://openssl-library.org/news/vulnerabilities/)
- [Debian security tracker: CVE-2026-14456](https://security-tracker.debian.org/tracker/CVE-2026-14456)
- [Distroless Node.js images](https://github.com/GoogleContainerTools/distroless/tree/main/nodejs)
- [Trivy finding exceptions](https://trivy.dev/latest/docs/configuration/filtering/)

## Decision

- `tools/trivy-gpu-controller-ignore.yaml`は`CVE-2026-14456`と、検出したDebian packageの完全PURL
  `pkg:deb/debian/libssl3t64@3.5.6-1~deb13u2?arch=amd64&distro=debian-13.6`の組だけを除外する。
- このignore fileをcontroller scanだけへ明示的に渡す。RunPod worker、quality image、Cloud Run GPU workerのscanには
  適用しない。
- 期限を2026-09-20とする。期限後はTrivyとsource testの両方がfail closedする。
- controller offline invariantはNode processのshared object report取得成功と、`libssl.so*`未ロードを必須にする。
  reportを取得できない場合も受理しない。
- 修正版Debian packageを含む公式distroless Node 24 digestが利用可能になった時点、または固定Trivy scanから
  findingが消えた時点の早い方でignoreを削除し、base digest、image inspection fixture、SBOM、scanを同じ変更で更新する。
- controllerがUDP、QUIC、native OpenSSL addon、またはOS `libssl`を使用する変更は、この例外の前提を無効にし、
  ignore削除または別ADRによる再評価までreleaseを停止する。

## Consequences

- 現在のcontrollerが到達できないQUIC Listener経路だけをpackage identity込みで除外し、それ以外の
  HIGH/CRITICAL findingは従来どおりcandidate publish前に停止する。
- Node executableの静的調査だけに依存せず、実際の最小imageをoffline起動したprocessのshared object集合で前提を検査する。
- Debian修正版が未提供でもrelease gateを進められるが、期限までにbase image状況を再確認する運用作業が必要になる。
- これはproduction resourceや既存candidateの変更ではない。source変更として新candidate buildとstaging acceptanceを必要とする。
