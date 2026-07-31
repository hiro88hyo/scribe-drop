# ScribeDrop RunPod Worker

Python 3.12 と uv で管理する RunPod Serverless worker。外部入力はPydantic strict
modelで検証し、winner claimより前にmodel load、source download、ffprobeを行わない。
HTTPはexact host allowlist、public DNS検証、検証済みIPへの接続固定、元hostのTLS
SNI維持、redirect無効で実行する。

```bash
uv sync --project apps/runpod-worker --frozen
uv run --directory apps/runpod-worker ruff check .
uv run --directory apps/runpod-worker ruff format --check .
uv run --directory apps/runpod-worker mypy --strict src tests
uv run --directory apps/runpod-worker pytest
```

`MODEL_PATH`はlocal以外では`/opt/models/large-v3-turbo`に固定する。model directoryは
image build時に固定commitから作成し、5つの構成fileすべてのbyte sizeとSHA-256を検証する。
runtimeでHugging Faceから取得するfallbackは許可しない。実imageはrootからbuildする。

```bash
pnpm container:build:runpod
pnpm container:check:runpod
```

後者はnetworkなし、read-only root filesystem、UID 10001で起動し、model bundle、
Python package、native import、ffprobeを検証する。GPU modelのmemory loadや推論は
この検査では行わない。

handlerは成功、失敗、cancelのすべてでtask固有`/tmp`を削除し、RunPod SDKへ
`refresh_worker=true`を返す。このfieldはRunPod SDKがjob outputから除去する。さらに
`serverless.start`にも`refresh_worker=true`を固定し、result送信後にSDK自身のjob loopを
終了する。control planeのPod停止反映だけへ依存しない。
