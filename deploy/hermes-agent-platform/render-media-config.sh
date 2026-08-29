#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets_dir="${SECRETS_DIR:-${deployment_dir}/secrets}"
runtime_dir="${RUNTIME_DIR:-${deployment_dir}/runtime}"

required_value() {
    local name="$1"
    local value="${!name:-}"
    if [[ -z "${value}" ]]; then
        echo "${name} is required" >&2
        exit 1
    fi
    printf '%s' "${value}"
}

required_secret() {
    local path="${secrets_dir}/$1"
    if [[ ! -s "${path}" ]]; then
        echo "Missing non-empty secret file: ${path}" >&2
        exit 1
    fi
    tr -d '\r\n' < "${path}"
}

livekit_key="$(required_secret livekit_api_key)"
livekit_secret="$(required_secret livekit_api_secret)"
turn_secret="$(required_secret turn_shared_secret)"
livekit_domain="$(required_value LIVEKIT_DOMAIN)"
turn_realm="$(required_value TURN_REALM)"
turn_external_ip="$(required_value TURN_EXTERNAL_IP)"
rtc_udp_port="${LIVEKIT_RTC_UDP_PORT:-7882}"
rtc_tcp_port="${LIVEKIT_RTC_TCP_PORT:-7881}"
turn_min_port="${COTURN_MIN_PORT:-49160}"
turn_max_port="${COTURN_MAX_PORT:-49200}"

for secret in "${livekit_key}" "${livekit_secret}" "${turn_secret}"; do
    if [[ ! "${secret}" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
        echo "Media keys must be at least 16 URL-safe characters" >&2
        exit 1
    fi
done
if [[ ! "${turn_external_ip}" =~ ^[0-9a-fA-F:.]+$ ]]; then
    echo "TURN_EXTERNAL_IP must be an IPv4 or IPv6 address" >&2
    exit 1
fi

mkdir -p "${runtime_dir}"
umask 077
printf '%s\n' \
    'port: 7880' \
    'log_level: info' \
    'rtc:' \
    "  tcp_port: ${rtc_tcp_port}" \
    "  udp_port: ${rtc_udp_port}" \
    '  use_external_ip: true' \
    'redis:' \
    '  address: redis:6379' \
    'keys:' \
    "  ${livekit_key}: ${livekit_secret}" \
    > "${runtime_dir}/livekit.yaml"

printf '%s\n' \
    'listening-port=3478' \
    'fingerprint' \
    'lt-cred-mech' \
    'use-auth-secret' \
    "static-auth-secret=${turn_secret}" \
    "realm=${turn_realm}" \
    "external-ip=${turn_external_ip}" \
    "min-port=${turn_min_port}" \
    "max-port=${turn_max_port}" \
    'stale-nonce=600' \
    'no-cli' \
    'no-loopback-peers' \
    'no-multicast-peers' \
    > "${runtime_dir}/turnserver.conf"

echo "Rendered locked media configuration in ${runtime_dir} for ${livekit_domain}."
