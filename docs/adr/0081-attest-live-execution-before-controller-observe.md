# ADR 0081: controller observe前のexact live Executionをattestする

## Context

Phase 14のsecond exact-one staging executionでは、Cloud Runが`jobs.run`直後にruntime taskを起動する一方、
controller recordは最初の`observe`まで`EXECUTION_PENDING`かつExecution UID未保存だった。従来のattestationは
recordが`RUNNING`で保存済みExecution UIDとlive UIDが一致する場合だけ`manifestMatches=true`としたため、identity
bootstrapがcontroller observeを追い越す正常な順序をresource driftとして拒否する。

service identity tokenはExecution UIDを署名しないため、単にpending recordを信頼することはできない。一方、controllerは
finite authorization下でfixed Jobを作成し、`runIntent`をversion CASで永続化してからexact 1回だけ`jobs.run`を送る。
live APIからexact Job、exact 1 Execution、fixed manifest、task 1、retry 0を毎回照合できる。

## Decision

- attestationは`runIntent=true`かつrecord stateが`EXECUTION_PENDING`または`RUNNING`の場合だけlive Executionを候補にする。
- stored Job UIDは常にlive Job UIDと完全一致させる。
- stored Executionが存在する場合は従来どおりlive Execution UIDと完全一致させる。まだobserveされていない場合だけ
  stored Executionの欠落を許し、live listがexact 1件であることを代替条件にする。
- live ExecutionのJob parent、state、task count、retry count、fixed manifest、runtime service accountは引き続き完全照合する。
- attestationはread-onlyを維持し、recordを更新しない。0件、複数件、別Job、manifest drift、run intentなし、terminal recordは拒否する。

## Consequences

- Cloud Run taskがcontroller observeより先にbootstrapしても、controllerが開始したexact live Executionだけをattestできる。
- observe前はstored Execution UIDという補助証拠を利用できない。finite single-active、durable run intent、stored Job UID、
  exact live listとmanifest比較がこの短い窓の補償controlになる。
- Phase 14の新candidateで実順序を再検証するまでproduction採用とproduction routingは行わない。

## Status

Accepted
