# Pairing rewrite behind HTTPS

When Tailscale Serve terminates HTTPS and forwards to LearnHarness over HTTP,
Next builds the request URL with the forwarded scheme. It normalizes the
loopback hostname to `localhost`. When the resulting rewrite origin differs
from the router's origin, Next fetches the destination. With an HTTPS rewrite
URL, it attempts TLS against the plain HTTP listener and returns 500.

The signed-out page rewrite targets `/pair` on the local HTTP listener. A
signed-out browser sees the pairing screen and keeps its original address,
over direct HTTP and through a TLS-terminating reverse proxy. The proxy's
forwarded scheme still marks the browser's pairing cookie `Secure`.

Check the base and fix with the same local TLS reverse proxy. Protected API
requests without a credential return 401. The pairing page, credential
exchanges, health check, and static assets stay public. Signed-in page
requests continue to reach the application.
