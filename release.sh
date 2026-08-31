#!/usr/bin/env bash
#
# release.sh - publish the Orbit image to Docker Hub.
#
# Shows what is already published, asks which version this one is, then builds
# for both CPU architectures and pushes. The architectures are the whole reason
# this is a script and not `docker push`: a plain push from an Apple Silicon Mac
# publishes an arm64-only image, which fails for everyone on an Intel or AMD
# machine with "no matching manifest".
#
#   ./release.sh                 # asks for the version
#   ./release.sh 1.0.1           # or take it from the command line
#   ./release.sh --dry-run       # build both architectures, publish nothing
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${ORBIT_IMAGE:-theashutosh/orbit}"
PLATFORMS="${ORBIT_PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${ORBIT_BUILDER:-multiplatform-builder}"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

VERSION=""
DRY_RUN=false
ASSUME_YES=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -y|--yes)  ASSUME_YES=true ;;
    --force)   FORCE=true ;;
    -h|--help) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown option: $arg" ;;
    *)         VERSION="$arg" ;;
  esac
done

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "Docker is not running - start Docker Desktop and try again"
docker buildx version >/dev/null 2>&1 || die "docker buildx is missing (it ships with Docker Desktop)"

# A builder that can cross-build. The `default` one only builds for this machine.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  info "creating buildx builder '$BUILDER'"
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

# Being logged out only surfaces at the end of a long build otherwise.
if ! grep -q 'index.docker.io' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
  die "not logged in to Docker Hub - run: docker login -u ${IMAGE%%/*}"
fi

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  warn "working tree has uncommitted changes - they WILL be baked into this image"
fi

# --- what is already out there ----------------------------------------------
# Public read, no auth needed. Falls back to whatever is tagged locally when
# offline, so the script still works on a plane.
published_versions() {
  curl -fsS --max-time 10 \
    "https://hub.docker.com/v2/repositories/${IMAGE}/tags?page_size=100" 2>/dev/null |
    grep -oE '"name": *"[^"]+"' | sed -E 's/.*"name": *"([^"]+)".*/\1/' |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V ||
  docker image ls "$IMAGE" --format '{{.Tag}}' |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V
}

info "image: $IMAGE"
VERSIONS="$(published_versions || true)"
if [ -n "$VERSIONS" ]; then
  LATEST="$(printf '%s\n' "$VERSIONS" | tail -1)"
  printf '  published: %s\n' "$(printf '%s\n' "$VERSIONS" | tr '\n' ' ')"
  printf '  latest:    \033[1m%s\033[0m\n' "$LATEST"
else
  LATEST=""
  printf '  published: none found (first release, or Docker Hub unreachable)\n'
fi

# Suggest the next patch, which is what most releases are.
if [ -n "$LATEST" ]; then
  SUGGEST="$(printf '%s' "$LATEST" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"
else
  SUGGEST="$(grep -m1 '"version"' package.json 2>/dev/null | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
  SUGGEST="${SUGGEST:-1.0.0}"
fi

# --- which version ----------------------------------------------------------
if [ -z "$VERSION" ]; then
  printf '\n  new version [\033[1m%s\033[0m]: ' "$SUGGEST"
  read -r VERSION
  VERSION="${VERSION:-$SUGGEST}"
fi

printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  die "version must look like 1.2.3, got: $VERSION"

if [ "$FORCE" = false ] && printf '%s\n' "$VERSIONS" | grep -qx "$VERSION"; then
  die "$IMAGE:$VERSION is already published - bump the version, or pass --force to overwrite it"
fi

# Only move :latest when this really is the newest version, so republishing an
# old line as a fix does not hand everyone a downgrade.
TAGS=(-t "${IMAGE}:${VERSION}")
MOVES_LATEST=false
if [ -z "$LATEST" ] || [ "$(printf '%s\n%s\n' "$LATEST" "$VERSION" | sort -V | tail -1)" = "$VERSION" ]; then
  TAGS+=(-t "${IMAGE}:latest")
  MOVES_LATEST=true
fi

# --- confirm ----------------------------------------------------------------
REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '\n'
info "about to build and push:"
printf '  tags:       %s:%s%s\n' "$IMAGE" "$VERSION" "$([ "$MOVES_LATEST" = true ] && echo "  +  ${IMAGE}:latest")"
printf '  platforms:  %s\n' "$PLATFORMS"
printf '  revision:   %s\n' "$REVISION"
[ "$DRY_RUN" = true ] && printf '  \033[33mdry run: builds both architectures, pushes nothing\033[0m\n'
printf '\n'

if [ "$ASSUME_YES" = false ]; then
  printf '  continue? [y/N] '
  read -r reply
  case "$reply" in [yY]*) ;; *) die "cancelled" ;; esac
fi

# --- build and push ---------------------------------------------------------
# A multi-architecture image cannot exist as a single local image, so buildx
# publishes it directly rather than building then pushing.
OUTPUT=(--push)
[ "$DRY_RUN" = true ] && OUTPUT=(--output=type=cacheonly)

info "building for $PLATFORMS - first run has no cache and takes a while"
docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --build-arg "ORBIT_VERSION=${VERSION}" \
  --label "org.opencontainers.image.revision=${REVISION}" \
  "${TAGS[@]}" \
  "${OUTPUT[@]}" \
  .

if [ "$DRY_RUN" = true ]; then
  info "dry run finished - both architectures build, nothing was published"
  exit 0
fi

# --- verify what landed -----------------------------------------------------
info "verifying the published manifest"
GOT="$(docker buildx imagetools inspect "${IMAGE}:${VERSION}" 2>/dev/null |
  grep -oE 'linux/[a-z0-9]+' | sort -u | tr '\n' ' ')"
printf '  architectures published: %s\n' "${GOT:-none}"
for want in ${PLATFORMS//,/ }; do
  printf '%s' "$GOT" | grep -q "$want" || die "$want is missing from the published image"
done

printf '\n\033[32mdone\033[0m  %s:%s is live%s\n' "$IMAGE" "$VERSION" \
  "$([ "$MOVES_LATEST" = true ] && echo " and :latest now points at it")"
printf '  anyone can now run:  docker pull %s:%s\n' "$IMAGE" "$VERSION"
[ "$MOVES_LATEST" = true ] && printf '  existing users update: docker compose pull && docker compose up -d\n'
