ARCHES := x86
# overrides to s9pk.mk must precede the include statement
include node_modules/@start9labs/start-sdk/s9pk.mk

# Docker cannot COPY from outside its build context, and the SDK resolves the
# dockerfile relative to THIS directory, so the two host files and the demo tracks are
# copied in before the image build. PHONY because the track filenames contain spaces
# and make splits prerequisite lists on whitespace.
.PHONY: stage
stage:
	rm -rf stage && mkdir -p stage/host stage/music
	cp ../../host/server.js ../../host/index.js stage/host/
	cp ../../assets/demo-music/*.mp3 stage/music/
	@echo "[stage] $$(ls stage/host | wc -l) host files, $$(ls stage/music | wc -l) tracks"

# Build the runtime image and push it to a throwaway local registry for `pack` to pull.
# Needed because the SDK's dockerBuild requires real Docker (buildx `-o type=docker`),
# and this box has podman. The s9pk embeds the image, so the registry is build-time only.
REG := 127.0.0.1:5555
IMG := $(REG)/peartune-probe:0.1

.PHONY: image
image: stage
	-podman rm -f s9reg
	podman run -d --name s9reg -p $(REG):5000 docker.io/library/registry:2
	sleep 4
	podman build --platform linux/amd64 -t $(IMG) -f Dockerfile .
	podman push --tls-verify=false $(IMG)
