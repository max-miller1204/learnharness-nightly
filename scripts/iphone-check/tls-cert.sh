#!/usr/bin/env bash
# tls-cert.sh <dir>: a throwaway CA (ca.pem) and a server certificate for
# 127.0.0.1 signed by it (cert.pem, key.pem), valid for two days. The CI
# iPhone job trusts ca.pem only inside its own simulator.
set -euo pipefail
DIR=${1:?usage: tls-cert.sh <dir>}
mkdir -p "$DIR"
cd "$DIR"
cat >openssl.cnf <<'EOF'
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1, DNS:localhost
EOF
openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days 2 -subj "/CN=LearnHarness CI throwaway CA" \
	-config openssl.cnf -extensions ca -keyout ca.key -out ca.pem 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=127.0.0.1" -config openssl.cnf -keyout key.pem -out server.csr 2>/dev/null
openssl x509 -req -sha256 -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
	-extfile openssl.cnf -extensions server -out cert.pem 2>/dev/null
openssl verify -CAfile ca.pem cert.pem >/dev/null
echo "$DIR/ca.pem"
