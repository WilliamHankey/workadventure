#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_dir="${BACKUP_DIR:?set BACKUP_DIR to a dedicated backup directory}"
postgres_db="${POSTGRES_DB:-agent_platform}"
postgres_user="${POSTGRES_USER:-agent_platform}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/agent-platform-${timestamp}.dump"
temporary="${target}.partial"

mkdir -p "${backup_dir}"
umask 077
cd "${deployment_dir}"
docker compose exec -T postgres pg_dump --format=custom --no-owner --no-acl -U "${postgres_user}" "${postgres_db}" > "${temporary}"
test -s "${temporary}"
mv "${temporary}" "${target}"
sha256sum "${target}" > "${target}.sha256"

echo "Created ${target}"
echo "Backups older than ${BACKUP_RETENTION_DAYS:-14} days are reported, not automatically deleted:"
find "${backup_dir}" -maxdepth 1 -type f -name 'agent-platform-*.dump' -mtime "+${BACKUP_RETENTION_DAYS:-14}" -print
