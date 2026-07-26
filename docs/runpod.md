# RunPod

## 現在の checkpoint

Phase 4ではCloudflare側のsubmission、claim、heartbeatと、RunPod Workerのlocal runtime、
固定model入りimageまで実装している。実RunPod endpoint、GPU benchmark、timeout/TTL確定、
staging smokeは未完了であり、productionへ投入しない。

## Image supply chain

imageは`linux/amd64`専用のmulti-stage buildとする。選択値は
`tools/versions.json`と`apps/runpod-worker/Dockerfile`を同期させる。

| Component         | Fixed value                                                        |
| ----------------- | ------------------------------------------------------------------ |
| Dockerfile syntax | `docker/dockerfile:1.7`のamd64 digest                              |
| build uv image    | `ghcr.io/astral-sh/uv:0.11.32`のamd64 digest                       |
| runtime base      | `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04`のamd64 digest       |
| Ubuntu snapshot   | `20260725T000000Z`                                                 |
| CA certificates   | `20260601~24.04.1`                                                 |
| Python package    | `3.12.3-1ubuntu0.15`                                               |
| FFmpeg package    | `7:6.1.1-3ubuntu5`                                                 |
| model repository  | `dropbox-dash/faster-whisper-large-v3-turbo`                       |
| model revision    | `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`                         |
| model.bin SHA-256 | `e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da` |

NVIDIAのapt sourceはbuild前に削除し、Ubuntuのarchiveとsecurity sourceは固定snapshotの
同一originへ置換する。modelはbuild時だけ公開repositoryからexact revisionと5 fileだけを
取得し、全fileのbyte sizeとSHA-256を検証する。Hugging Faceのcache metadataはimageへ
残さず、検証済みprovenanceを`model-metadata.json`へ保存する。

runtime imageにuvは含めず、UID/GID 10001、固定`MODEL_PATH`、Hugging Face関連のoffline
flagで実行する。model directoryはroot所有かつwrite不可とする。runtimeのtranscriberも
`local_files_only=True`を指定する。

## Local verification

root build contextから実行する。

```bash
pnpm container:build:runpod
pnpm container:check:runpod
```

offline checkは`--network none`、read-only root filesystem、一時`/tmp`だけwrite可能な
条件で起動する。次を検証し、RunPodのjob loopやGPU推論は開始しない。

- effective UIDがrootではない
- offline flagとmodel pathが固定値である
- model全fileとprovenanceのsize/hashが一致する
- RunPod SDK、faster-whisper、CTranslate2、Pydantic、httpx、Hugging Face Hubが固定versionである
- native moduleをimportできる
- ffprobe 6.1.1を起動できる

CIでは最終imageにSyftのSPDX JSON SBOMとTrivyのOS/library scanを実行する。専用の
一時runnerは不要なpreinstalled toolchainを削除し、25 GiB以上の空きを確認してから
buildとscanを開始する。High/Critical findingはfixed/unfixedを問わずjobを失敗させる。
例外は暗黙にignoreせず、脅威、補償制御、期限、除去条件をADRへ記録する。

## Endpoint invariant

stagingとproductionは別endpoint/template/image digestを使用する。設定は次から緩めず、
満たせない場合はdeployを停止する。

- Secure Cloud
- Flex
- active workers 0
- max workers 1
- GPU 1
- Network Volumeなし
- 永続diskなし
- FlashBoot無効

templateへRunPod API key、R2長期credential、Discord webhookを渡さない。Workerの
環境変数は`docs/environment-variables.md`の非secret設定だけとし、per-job capabilityは
一回限りclaimの成功responseから取得する。

## Deployment and rollback

registryへpushしたimageはtagだけでなくregistry digestを記録し、RunPod templateは
上書きせず新revisionとして作成する。stagingのoffline check、scan、SBOM、GPU benchmark、
claim競合、artifact/manifest、cleanupを確認してからendpointを切り替える。rollbackは
直前に検証済みのimage digestとtemplate revisionへ戻し、volumeやFlashBootを有効化しない。
