#!/usr/bin/env bash
# Both CI and manual rollouts use this sequence. The argument is a tested commit.
set -euo pipefail
commit=${1:?Usage: deploy.sh COMMIT STAGED_DIRECTORY}
staged=$(cd "${2:?Missing staged directory}" && pwd)
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
cd "$HOME/agent-platform"
exec 9>"$HOME/agent-platform.deploy.lock"
flock -w 600 9
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$HOME/agent-platform-backups/$stamp-$commit"
mkdir -p "$backup"
cp .env docker-compose.prod.yml "$backup/"
if [[ -f deployed-commit ]]; then cp deployed-commit "$backup/"; fi
docker compose -p agent-platform -f docker-compose.prod.yml config > "$backup/compose-resolved.yml"
docker compose -p agent-platform -f docker-compose.prod.yml exec -T db pg_dump -U platform -d platform -Fc > "$backup/database.dump"
test -s "$backup/database.dump"
docker compose -p agent-platform -f docker-compose.prod.yml exec -T db pg_restore --list < "$backup/database.dump" > "$backup/database-contents.txt"
printf 'services:\n' > "$backup/rollback.yml"
for service in web worker pdf-compiler; do
  container=$(docker compose -p agent-platform -f docker-compose.prod.yml ps -q "$service")
  if [[ -n "$container" ]]; then
    image=$(docker inspect --format '{{.Image}}' "$container")
    tag="agent-platform-rollback-$service:$stamp"
    docker image tag "$image" "$tag"
    printf '  %s:\n    image: %s\n' "$service" "$tag" >> "$backup/rollback.yml"
  fi
done
# Never replace the live environment or durable volumes. Backups live outside rsync.
rsync -az --delete --exclude-from="$staged/.dockerignore" --exclude=.env --exclude=deployed-commit "$staged/" ./
compose=(docker compose -p agent-platform -f docker-compose.prod.yml)
"${compose[@]}" build pdf-compiler web worker migrate
"${compose[@]}" up -d --no-deps --wait pdf-compiler
"${compose[@]}" exec -T pdf-compiler python3 -c 'import json,urllib.request; data=json.load(urllib.request.urlopen("http://localhost:8080/health")); assert "tectonic-0.15.0-bundle33-report-v1" in data["profiles"]; assert "tectonic-0.15.0-bundle33-template-v2" in data["profiles"]; assert "tectonic-0.15.0-bundle33-template-v3" in data["profiles"]'
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --no-deps web worker
healthy=false
for attempt in {1..30}; do
  if "${compose[@]}" exec -T web node -e 'fetch("http://localhost:3000/api/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' &&
    "${compose[@]}" logs --since 2m worker | grep -q 'Agent worker ready'; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  docker compose -p agent-platform -f "$backup/docker-compose.prod.yml" -f "$backup/rollback.yml" --project-directory "$PWD" up -d --no-build --no-deps web worker pdf-compiler
  echo "Readiness failed; restored previous images. Additive migrations retained. Backup: $backup" >&2
  exit 1
fi
"${compose[@]}" exec -T web pnpm exec tsx scripts/deployment-pdf-smoke.ts
printf '%s\n' "$commit" > deployed-commit
printf 'Deployed %s\nBackup: %s\n' "$commit" "$backup"
