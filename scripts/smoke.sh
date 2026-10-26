#!/usr/bin/env bash
# Runs the image as it is deployed (read-only, no capabilities, secrets as files) with dummy values, and checks that
# it becomes healthy, runs as uid 1000, has no npm, refuses an incomplete configuration, and logs no secret.
# It makes no outbound calls: cms-gate only reaches GitHub and the RGW when an editor signs in or uploads.
#   scripts/smoke.sh <image>
set -euo pipefail

IMAGE="${1:?usage: scripts/smoke.sh <image>}"
dir="$(mktemp -d)"
name="cms-gate-smoke-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

docker run --rm --network none "$IMAGE" node -e \
  "process.stdout.write(require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}))" \
  > "$dir/github-private-key"
printf 'smoke-client-secret-value' > "$dir/github-client-secret"
printf 'SMOKEACCESSKEYID' > "$dir/s3-access-key-id"
printf 'smoke-s3-secret-value' > "$dir/s3-secret-access-key"
chmod 755 "$dir"
chmod 644 "$dir"/*

env_args=(
  -e GITHUB_APP_ID=1 -e GITHUB_CLIENT_ID=Iv1.smoke -e GITHUB_INSTALLATION_ID=1
  -e GITHUB_ORG=arquivo -e GITHUB_TEAM=sobre-editors
  -e GITHUB_CLIENT_SECRET_FILE=/run/secrets/github-client-secret
  -e GITHUB_PRIVATE_KEY_FILE=/run/secrets/github-private-key
  -e CMS_ORIGIN=https://cms.example.test
  -e S3_ENDPOINT=https://s3.example.test -e S3_BUCKET=sobre-media -e S3_PREFIX=media/
  -e S3_ACCESS_KEY_ID_FILE=/run/secrets/s3-access-key-id
  -e S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3-secret-access-key
)
hardening=(--read-only --cap-drop ALL --security-opt no-new-privileges:true)

echo "· an incomplete configuration is refused"
if out="$(docker run --rm --network none "${hardening[@]}" "$IMAGE" 2>&1)"; then
  echo "started without configuration" >&2
  exit 1
fi
grep -q 'GITHUB_APP_ID is required' <<<"$out"

echo "· the service starts read-only and becomes healthy"
docker run -d --name "$name" "${hardening[@]}" -p 127.0.0.1::8787 --health-interval 2s \
  -v "$dir:/run/secrets:ro" "${env_args[@]}" "$IMAGE" >/dev/null
status=starting
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [ "$status" = starting ] || break
  sleep 1
done
if [ "$status" != healthy ]; then
  docker logs "$name" >&2
  echo "health: $status" >&2
  exit 1
fi
port="$(docker port "$name" 8787/tcp | head -n1 | sed 's/.*://')"
[ "$(curl -fsS "http://127.0.0.1:$port/cms-api/health")" = '{"status":"ok"}' ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/cms-api/media")" = 401 ]

echo "· it runs as uid 1000, without npm"
[ "$(docker exec "$name" id -u)" = 1000 ]
if docker exec "$name" sh -c 'command -v npm || command -v npx'; then
  echo "npm is in the runtime image" >&2
  exit 1
fi

echo "· its logs hold no secret"
logs="$(docker logs "$name" 2>&1)"
for secret in smoke-client-secret-value SMOKEACCESSKEYID smoke-s3-secret-value 'PRIVATE KEY'; do
  if grep -q "$secret" <<<"$logs"; then
    echo "log holds a secret" >&2
    exit 1
  fi
done
echo "smoke test passed"
