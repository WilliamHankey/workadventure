#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets_dir="${SECRETS_DIR:-${deployment_dir}/secrets}"
runtime_dir="${RUNTIME_DIR:-${deployment_dir}/runtime}"
webhook_file="${secrets_dir}/alert_webhook_url"

if [[ ! -s "${webhook_file}" ]]; then
    echo "Missing non-empty alert webhook file: ${webhook_file}" >&2
    exit 1
fi
webhook_url="$(tr -d '\r\n' < "${webhook_file}")"
if [[ ! "${webhook_url}" =~ ^https:// ]]; then
    echo "Alert webhook must use https://" >&2
    exit 1
fi
escaped_url="${webhook_url//\'/\'\'}"

mkdir -p "${runtime_dir}"
umask 077
printf '%s\n' \
    'route:' \
    '  receiver: operator-webhook' \
    '  group_by: [alertname]' \
    '  group_wait: 30s' \
    '  group_interval: 5m' \
    '  repeat_interval: 4h' \
    'receivers:' \
    '  - name: operator-webhook' \
    '    webhook_configs:' \
    "      - url: '${escaped_url}'" \
    '        send_resolved: true' \
    > "${runtime_dir}/alertmanager.yml"

echo "Rendered locked Alertmanager configuration in ${runtime_dir}."
