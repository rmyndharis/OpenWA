#!/bin/sh
# Install the pinned Trivy release for the image scans in release.yml and security-scan.yml.
# Usage: ./scripts/install-trivy.sh   (on a Linux x86_64 runner)
#
# aquasecurity/trivy-action installs Trivy through contrib/install.sh, which downloads the tarball from
# get.trivy.dev. That name returned NXDOMAIN on 2026-11-04 (curl exit 6, aquasecurity/setup-trivy#42), so
# the install step fails before a scan starts. This takes the same tarball from the GitHub release and checks it
# against a digest kept here: the scan no longer depends on the name, and a replaced asset fails the job.
# The scan steps set `skip-setup-trivy: 'true'` and find the binary on PATH.
#
# To move to another Trivy release, change VERSION and SHA256 together. The digest of
# trivy_<version>_Linux-64bit.tar.gz is in the release's trivy_<version>_checksums.txt. The matrix platform
# of the scan jobs only selects which image architecture Trivy reads; the runner itself is x86_64.
set -eu

VERSION=0.70.0
SHA256=8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-trivy.sh: the pinned digest is for the Linux 64-bit build, this host is $(uname -s)-$(uname -m)" >&2
  exit 1
fi

dir="${RUNNER_TEMP:-$(mktemp -d)}/trivy-$VERSION"
mkdir -p "$dir"
archive="$dir/trivy.tar.gz"

curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
  --output "$archive" \
  "https://github.com/aquasecurity/trivy/releases/download/v${VERSION}/trivy_${VERSION}_Linux-64bit.tar.gz"
echo "$SHA256  $archive" | sha256sum --check --strict -
tar --extract --gzip --file "$archive" --directory "$dir" trivy

# Later steps of the job find `trivy` on PATH.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dir" >> "$GITHUB_PATH"
fi
"$dir/trivy" --version
