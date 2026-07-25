#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
versions_file="${repository_root}/tools/versions.json"

case "$(uname -s)" in
  Darwin) operating_system="darwin" ;;
  Linux) operating_system="linux" ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) architecture="arm64" ;;
  x86_64 | amd64) architecture="x64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

artifact_key="${operating_system}-${architecture}"
version="$(
  node -e '
    const versions = require(process.argv[1]);
    process.stdout.write(versions.runpodctl.version);
  ' "${versions_file}"
)"
filename="$(
  node -e '
    const versions = require(process.argv[1]);
    const artifact = versions.runpodctl.artifacts[process.argv[2]];
    if (!artifact) process.exit(1);
    process.stdout.write(artifact.filename);
  ' "${versions_file}" "${artifact_key}"
)"
expected_sha256="$(
  node -e '
    const versions = require(process.argv[1]);
    const artifact = versions.runpodctl.artifacts[process.argv[2]];
    if (!artifact) process.exit(1);
    process.stdout.write(artifact.sha256);
  ' "${versions_file}" "${artifact_key}"
)"

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "${temporary_directory}"' EXIT

download_path="${temporary_directory}/${filename}"
download_url="https://github.com/runpod/runpodctl/releases/download/v${version}/${filename}"

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "${download_url}" \
  --output "${download_path}"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "${download_path}" | cut -d ' ' -f 1)"
else
  actual_sha256="$(shasum -a 256 "${download_path}" | cut -d ' ' -f 1)"
fi

if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "runpodctl checksum mismatch" >&2
  echo "expected: ${expected_sha256}" >&2
  echo "actual:   ${actual_sha256}" >&2
  exit 1
fi

install_directory="${repository_root}/.tools/bin"
mkdir -p "${install_directory}"
install -m 0755 "${download_path}" "${install_directory}/runpodctl"

"${install_directory}/runpodctl" version
