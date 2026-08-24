#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_file="${1:?usage: CONFIRM_RESTORE=agent-platform <script> /absolute/path/to/backup.dump}"
postgres_db="${POSTGRES_DB:-agent_platform}"
postgres_user="${POSTGRES_USER:-agent_platform}"

if [[ "${CONFIRM_RESTORE:-}" != "agent-platform" ]]; then
    echo "Restore replaces current agent-platform database objects. Set CONFIRM_RESTORE=agent-platform." >&2
    exit 1
fi
if [[ "${backup_file}" != /* || ! -s "${backup_file}" ]]; then
    echo "The backup must be a non-empty absolute path." >&2
    exit 1
fi
if [[ -f "${backup_file}.sha256" ]]; then
    sha256sum --check "${backup_file}.sha256"
fi

cd "${deployment_dir}"
docker compose stop agent-platform
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner --no-acl -U "${postgres_user}" -d "${postgres_db}" < "${backup_file}"
docker compose start agent-platform
docker compose exec -T agent-platform node -e "fetch('http://127.0.0.1:3200/health/ready').then(r=>{if(!r.ok)process.exit(1)})"
echo "Restore completed and readiness passed. Verify Lowcoder records and agent desired state before reopening access."
