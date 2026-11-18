#!/usr/bin/env bash
set -euo pipefail

for name in MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_API_KEY_PEM APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Missing repository secret: ${name%_PEM}"
    exit 1
  fi
done

umask 077
key_path=$(mktemp "$RUNNER_TEMP/learnharness-notary.XXXXXX")
trap 'rm -f -- "$key_path"' EXIT
printf '%s\n' "$APPLE_API_KEY_PEM" > "$key_path"
IFS= read -r header < "$key_path"
if [[ "${header%$'\r'}" != '-----BEGIN PRIVATE KEY-----' ]]; then
  echo "::error::APPLE_API_KEY must contain a raw .p8 key starting with -----BEGIN PRIVATE KEY-----"
  exit 1
fi

printf 'key_path=%s\n' "$key_path" >> "$GITHUB_OUTPUT"
# The signing step owns the file after validation. The workflow always cleans it up.
trap - EXIT
