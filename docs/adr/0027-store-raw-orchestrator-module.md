# ADR 0027: Orchestratorのraw ES moduleをrelease candidateへ保存する

## Context

release candidate publicationは、Wranglerのdry-run buildで生成したOrchestratorの
`index.js`をcandidateへ保存し、stagingとproductionで同じfileを`--no-bundle` deploy
する設計である。

Wrangler 4.114.0でbindingを持つWorkerに`wrangler deploy --dry-run --outfile
<path>/index.js`を使用すると、指定fileにはraw JavaScriptではなく、metadataとmoduleを
含むmultipart upload bodyが出力された。このfileも通常のbyte列としてhashできるため、
従来のcandidate検証には成功したが、staging deployでは`Content-Disposition` headerを
JavaScriptとしてparseして失敗した。

`--outdir`はdeploy用のraw `index.js`と補助fileを別々に出力する。release candidateには
環境固有のupload envelopeではなく、stagingとproductionの両方へ投入できる同一の
application moduleが必要である。

## Decision

- candidate publicationでは固定Wranglerの`--outdir`を使用する。
- output directoryからraw `index.js`だけをOrchestrator artifactへcopyする。source map、
  README、multipart metadata、binding metadataはcandidateへ含めない。
- candidate作成時と再検証時の両方で、Orchestrator artifactがregular UTF-8 fileであり、
  空、NULを含むbinary、multipart boundary、`Content-Disposition: form-data`ではなく、
  ES moduleのdefault exportを持つことを検証する。
- content検証に成功したmoduleだけをcandidate manifestのSHA-256対象とする。
- stagingとproductionはcandidate内の同じraw moduleを`--no-bundle`でdeployし、promotion
  中に再buildしない。
- CI構成検査は`--outdir`を必須とし、既知のmultipart bodyを生成する`--outfile`指定を
  拒否する。
- Wrangler更新で出力形式が変化した場合は暗黙に受け入れず、fixture、validator、この
  ADRを更新する。

## Consequences

- hashが一致するだけでなく、deploy可能なartifact種別であることもcandidate境界で検証
  できる。
- Wranglerが生成する補助fileはcandidate同一性へ影響しない。
- validatorは完全なJavaScript parserではないため、syntaxとCloudflare互換性の最終検証は
  stagingの`wrangler deploy --no-bundle`と実service acceptanceが担う。
- default exportを持たない別形式へOrchestratorを変更する場合はcandidate contractの変更が
  必要になる。

## Status

Accepted

## References

- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
