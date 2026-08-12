#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
versions_file="${repository_root}/tools/versions.json"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Google Cloud CLI probe installer supports Linux only" >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
  echo "Google Cloud CLI probe installer supports x86_64 only" >&2
  exit 1
fi

artifact_key="linux-x64"
version="$(
  node -e '
    const versions = require(process.argv[1]);
    process.stdout.write(versions.googleCloudCli.version);
  ' "${versions_file}"
)"
filename="$(
  node -e '
    const versions = require(process.argv[1]);
    const artifact = versions.googleCloudCli.artifacts[process.argv[2]];
    if (!artifact) process.exit(1);
    process.stdout.write(artifact.filename);
  ' "${versions_file}" "${artifact_key}"
)"
expected_sha256="$(
  node -e '
    const versions = require(process.argv[1]);
    const artifact = versions.googleCloudCli.artifacts[process.argv[2]];
    if (!artifact) process.exit(1);
    process.stdout.write(artifact.sha256);
  ' "${versions_file}" "${artifact_key}"
)"

install_root="${repository_root}/.tools/google-cloud-sdk"
install_binary="${install_root}/bin/gcloud"
link_directory="${repository_root}/.tools/bin"
link_path="${link_directory}/gcloud"
config_root="${repository_root}/.tools/gcloud-config"
mkdir -p "${config_root}"
chmod 0700 "${config_root}"

if [[ -x "${install_binary}" ]]; then
  actual_version="$(
    env CLOUDSDK_CONFIG="${config_root}" "${install_binary}" version 2>/dev/null \
      | sed -n 's/^Google Cloud SDK //p'
  )"
  if [[ "${actual_version}" != "${version}" ]]; then
    echo "existing Google Cloud CLI version does not match the pinned version" >&2
    exit 1
  fi
  mkdir -p "${link_directory}"
  ln -sfn "${install_binary}" "${link_path}"
  env CLOUDSDK_CONFIG="${config_root}" "${link_path}" version
  exit 0
fi

if [[ -e "${install_root}" ]]; then
  echo "existing Google Cloud CLI path is incomplete; refusing to overwrite it" >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "${temporary_directory}"' EXIT
download_path="${temporary_directory}/${filename}"
download_url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/${filename}"

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "${download_url}" \
  --output "${download_path}"

actual_sha256="$(sha256sum "${download_path}" | cut -d ' ' -f 1)"
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "Google Cloud CLI checksum mismatch" >&2
  echo "expected: ${expected_sha256}" >&2
  echo "actual:   ${actual_sha256}" >&2
  exit 1
fi

tar -xzf "${download_path}" -C "${temporary_directory}"
mkdir -p "${repository_root}/.tools" "${link_directory}"
mv "${temporary_directory}/google-cloud-sdk" "${install_root}"
ln -s "${install_binary}" "${link_path}"
env CLOUDSDK_CONFIG="${config_root}" "${link_path}" version
