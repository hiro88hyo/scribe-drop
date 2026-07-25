# 継続的インテグレーション

## 対象

`.github/workflows/ci.yml` は `main` と `develop` への push と pull request、および手動実行で動作する。CI は外部サービスの credential を受け取らず、実際の Cloudflare や RunPod resource には接続しない。

同じ branch と workflow の古い実行は concurrency 設定で取り消し、全 job に timeout を設定する。workflow 全体の `GITHUB_TOKEN` 権限は `contents: read` のみに制限する。

## Job

| Job                | 検査内容                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`          | lockfile固定install、toolchain、format、lint、型検査、Vitest、pytest、build、local D1 migration、Web/OrchestratorのWorkers/D1/R2 integration |
| `secrets`          | Gitleaks による完全な Git 履歴と現在の checkout の検査                                                                                       |
| `dependency-audit` | `pnpm audit` と `uv audit` による直接・推移依存の既知脆弱性検査                                                                              |

`pnpm audit` と `uv audit` は脆弱性データサービスへ接続するため、通常の `pnpm check` とは分離する。ローカルで CI 相当を確認するときは次を実行する。

```bash
pnpm check
pnpm ci:verify
pnpm secrets:check
pnpm audit --audit-level high
uv audit --preview-features audit-command --project apps/runpod-worker --frozen
```

## Supply chain

- third-party Action は release tag だけでなく full commit SHA に固定し、隣のコメントに対応する tag を残す。
- `pnpm ci:verify` は workflow 内の `uses:` を検査し、floating reference の混入を拒否する。
- Action の更新時は公式 release と tag の commit を確認し、workflow 内の全参照を同じ PR で更新する。
- Gitleaks と runpodctl は `tools/versions.json` の version と公式 SHA-256 に固定し、検証後の binary だけを `.tools/bin` へ導入する。
- JavaScript と Python の install はそれぞれ `pnpm-lock.yaml` と `uv.lock` を frozen mode で使用する。

RunPod Worker のSBOM生成、container vulnerability scan、image内model revisionの検証、networkを切った起動試験は、Dockerfileと固定base imageを追加するPhase 4のチェックポイントで導入する。scan対象となるimageがない現在は、成功扱いの空jobを置かない。SBOMやscan artifactにはcredential、URL、録音、文字起こしfixtureを含めない。

## Branch protection

GitHub repository 作成後、`main` と `develop` への直接 push を禁止し、少なくとも `Quality gate`、`Secret scan`、`Dependency audit` を required status check に設定する。これは repository 側の設定であり、ローカル基盤作成では変更しない。
