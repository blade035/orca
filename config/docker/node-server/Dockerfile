ARG UBUNTU_VERSION=20.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=24.18.0
ARG TARGETARCH

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends binutils ca-certificates curl git xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
    amd64) node_arch=x64 ;; \
    arm64) node_arch=arm64 ;; \
    *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
  && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  && checksum_line="$(grep "  ${archive}$" SHASUMS256.txt)" \
  && test -n "$checksum_line" \
  && printf '%s\n' "$checksum_line" | sha256sum -c - \
  && tar -xJf "$archive" -C /usr/local --strip-components=1 \
  && rm "$archive" SHASUMS256.txt \
  && node --version \
  && npm --version

WORKDIR /opt/orca-test
COPY orca-server.tgz /opt/orca-test/orca-server.tgz
RUN npm init -y >/dev/null \
  && npm install ./orca-server.tgz --no-audit --no-fund \
  && ! command -v gcc \
  && ! command -v make

COPY verify-linux-glibc-floor.cjs runtime-verifier.cjs /opt/orca-test/
RUN node -e "const fs=require('node:fs'); const {ptyPath}=require('node-pty/lib/prebuild-file-path'); if(!ptyPath) throw new Error('active node-pty prebuild missing'); fs.mkdirSync('./active-native'); fs.copyFileSync(ptyPath,'./active-native/pty.node')" \
  && node -e "require('./verify-linux-glibc-floor.cjs').verifyLinuxGlibcFloor('./active-native')" \
  && node ./runtime-verifier.cjs \
    --cli ./node_modules/@stablyai/orca/dist/cli.js \
    --expected-version "$(node -p "require('./node_modules/@stablyai/orca/package.json').version")"
