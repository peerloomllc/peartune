# Build the PearTune host .s9pk for StartOS 0.3.5.x.
#
#   make            build + verify a universal s9pk (x86_64 + aarch64)
#   make install    install to the server in ~/.embassy/config.yaml (sideload)
#   make clean      remove build artifacts
#
# The pinned base image is a multi-arch manifest list (amd64 + arm64), so each
# arch tar just pulls its own layer. Building the arm64 tar on an amd64 host runs
# a tiny apt step under qemu emulation, so qemu-user-static (binfmt) must be
# registered. Requires: deno, yq, the StartOS SDK (start-sdk / start-cli), and
# either docker (buildx) OR podman. See scripts/build-image-tar.sh.

PKG_ID := $(shell yq e ".id" < manifest.yaml)
PKG_VERSION := $(shell yq e ".version" < manifest.yaml)
TS_FILES := $(shell find ./scripts -name \*.ts)

# delete a rule's target if its recipe fails partway
.DELETE_ON_ERROR:

all: verify

verify: $(PKG_ID).s9pk
	@start-sdk verify s9pk $(PKG_ID).s9pk
	@echo " Done!"
	@echo "   $(shell du -h $(PKG_ID).s9pk) is ready"

install:
	@if [ ! -f ~/.embassy/config.yaml ]; then \
		echo 'Define  host: https://<server>.local  in ~/.embassy/config.yaml first.'; exit 1; fi
	@echo "\nInstalling to $$(grep -v '^#' ~/.embassy/config.yaml | cut -d'/' -f3) ...\n"
	@[ -f $(PKG_ID).s9pk ] || $(MAKE)
	@start-cli package install $(PKG_ID).s9pk

clean:
	rm -rf docker-images demo-music
	rm -f $(PKG_ID).s9pk
	rm -f scripts/embassy.js

# Bundle the TS procedures (config, health, migrations, properties) into the
# single embassy.js the s9pk loads.
scripts/embassy.js: $(TS_FILES)
	deno run --allow-read --allow-write --allow-env --allow-net scripts/bundle.ts

# Build a per-arch runtime image and export it as a docker-archive tar the packer
# loads, tagged start9/<id>/main:<version>. Uses docker if present, else podman
# (see scripts/build-image-tar.sh). The tar name selects the build --platform.
# Stage the CC0 demo tracks into the build context. The Dockerfile COPYs them to
# /music, the host's default library dir, so a fresh install has something to play -
# which matters on StartOS because a stock box has no music server to point at.
# The source of truth is ../assets/demo-music; this is a copy because the image
# build context is start9/ and Docker cannot COPY from outside it.
# PHONY, not a wildcard prerequisite: the track filenames contain SPACES ("01
# Drowning in your smile.mp3") and make splits prerequisite lists on whitespace,
# so $(wildcard ...) asks for a rule to build "../assets/demo-music/01". Re-staging
# unconditionally costs one 18MB copy.
.PHONY: demo-music
demo-music:
	rm -rf demo-music && mkdir -p demo-music
	cp ../assets/demo-music/*.mp3 demo-music/
	@echo "[demo-music] staged $$(ls demo-music | wc -l) tracks"

docker-images/x86_64.tar: Dockerfile docker_entrypoint.sh scripts/build-image-tar.sh demo-music
	bash scripts/build-image-tar.sh $(PKG_ID) $(PKG_VERSION) docker-images/x86_64.tar linux/amd64

docker-images/aarch64.tar: Dockerfile docker_entrypoint.sh scripts/build-image-tar.sh demo-music
	bash scripts/build-image-tar.sh $(PKG_ID) $(PKG_VERSION) docker-images/aarch64.tar linux/arm64

# x86_64 only. A universal build runs the base image's apt step for arm64 under
# qemu, which is slow, and every Start9 box we test on is x86_64. Use this when
# you want an s9pk to sideload now, not a release artifact.
amd64: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar
	@echo "start-sdk: packing $(PKG_ID) v$(PKG_VERSION) (x86_64 only) ..."
	@start-sdk pack

# Universal s9pk carries both arch images; the manifest's hardware-requirements
# lists x86_64 + aarch64 so StartOS installs the right one per server.
$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar docker-images/aarch64.tar
	@echo "start-sdk: packing $(PKG_ID) v$(PKG_VERSION) (x86_64 + aarch64) ..."
	@start-sdk pack
