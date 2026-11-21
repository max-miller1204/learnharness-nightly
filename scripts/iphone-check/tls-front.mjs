#!/usr/bin/env node
/**
 * tls-front.mjs <listen port> <http port> <cert.pem> <key.pem>
 *
 * The phone app accepts only https:// servers, and the prove server listens
 * on plain HTTP. This ends TLS on 127.0.0.1:<listen port> and passes the raw
 * bytes to 127.0.0.1:<http port>, so streams and every route behave as they
 * do behind any TLS proxy. Used only by the CI iPhone job.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

const [listen, target, cert, key] = process.argv.slice(2);
if (!listen || !target || !cert || !key) {
	console.error("usage: tls-front.mjs <listen port> <http port> <cert.pem> <key.pem>");
	process.exit(2);
}
const server = tls.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (client) => {
	const upstream = net.connect(Number(target), "127.0.0.1");
	client.pipe(upstream).pipe(client);
	const end = () => { client.destroy(); upstream.destroy(); };
	client.on("error", end);
	upstream.on("error", end);
});
server.on("tlsClientError", (error) => console.error(`tls: ${error.message}`));
server.listen(Number(listen), "127.0.0.1", () => console.log(`tls-front https://127.0.0.1:${listen} -> http://127.0.0.1:${target}`));
