# Phase 4 staging deployment record

## 状態

Phase 4のRunPod staging endpoint checkpointを完了した。固定digestのprivate imageから
環境専用templateとendpointを作成し、初回workerがReadyになるまで起動してGPU配置と
Secure Cloudを確認した。

実account、endpoint、template、registry auth、image参照、origin、credentialはこの記録を
含む追跡対象へ保存しない。非secret IDを含む生成planとstateもgit ignoredの
`.runpod/deploy/`だけに保持する。

## 検証

- checksum検証済みのproject-local `runpodctl`で認証とAPI connectivityを確認した。
- CIが公開した固定image digestを使い、追跡外planからstaging専用templateとendpointを
  作成した。
- endpointはFlex、active workers 0、max workers 1、GPU 1、Network Volumeなし、
  永続volumeなし、FlashBoot無効である。
- 初回workerの起動後、RunPod ConsoleでRTX 4090への配置とSecure Cloudを確認した。
- workerがReadyになり、固定modelを含むimageがstaging runtimeで起動できることを確認した。
- 最小jobはCloudflare claim境界へ到達し、すでに期限切れとなったclaim tokenを安全に
  拒否して終了した。source URL、artifact capability、録音内容は渡されていない。
- staging D1に残った結果不明submissionはPhase 5のreconciliationで回収する。安全確認前に
  同じattemptを再投入したり、RunPod provider-side retryを使ったりしない。

## 残るcheckpoint

実音声のdownload、ffprobe、GPU推論、artifact/manifest PUT、terminal status保存、
finalize、Discord通知、cancel、cleanupと処理時間はPhase 5のstaging end-to-end smokeで
確認する。これらが完了するまでproductionへ投入しない。
