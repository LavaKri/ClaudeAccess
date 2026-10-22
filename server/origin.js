// Cross-origin request guard. The server has no authentication: its only
// barrier is listening on localhost, which doesn't stop a malicious web page
// open in the user's own browser from talking to it. WebSockets aren't
// subject to CORS at all, and "simple" requests (e.g. a POST with no body or
// a text/plain one) are sent cross-origin without any preflight — so both
// the WebSocket upgrade and every state-changing REST route check the
// browser-supplied Origin header against this server's own origin(s). Every
// request's Host header is also checked, against DNS rebinding.

import os from 'node:os';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = ['', '0.0.0.0', '::', '[::]'];

// URL.hostname brackets IPv6 literals ("[::1]") and lowercases names; the
// configured host may be written either way.
function normalizeHost (host) {
	host = String(host).trim().toLowerCase();
	if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
	return host;
}

// Every hostname the browser could legitimately be using to reach this
// server, given the configured listen address.
function allowedHostnames (configuredHost) {
	let host = normalizeHost(configuredHost);
	let hosts = new Set([host]);
	if (LOOPBACK_HOSTS.includes(host) || WILDCARD_HOSTS.includes(host)) {
		for (let loopback of LOOPBACK_HOSTS) hosts.add(loopback);
	}
	if (WILDCARD_HOSTS.includes(host)) {
		// Listening on every interface: also accept this machine's own name
		// and addresses, for access from another device on the network.
		hosts.add(normalizeHost(os.hostname()));
		for (let addresses of Object.values(os.networkInterfaces())) {
			for (let { address } of addresses || []) hosts.add(normalizeHost(address.split('%')[0]));
		}
	}
	hosts.delete('');
	return hosts;
}

// Returns a predicate telling whether a given Origin (or Referer) URL string
// belongs to this server itself.
export function createOriginChecker ({ host, port }) {
	let hostnames = allowedHostnames(host);
	return function isOwnOrigin (originString) {
		let url;
		try {
			url = new URL(originString);
		} catch {
			return false;
		}
		if (url.protocol !== 'http:') return false;
		let urlPort = Number(url.port || 80);
		return urlPort === Number(port) && hostnames.has(url.hostname.toLowerCase());
	};
}

// Returns a predicate telling whether a given Host header value names this
// server itself. Against DNS rebinding: an attacker's domain re-resolved to
// 127.0.0.1 makes their page same-origin with this server from the browser's
// point of view (so even GET routes become readable by it, and its Origin
// check above would see a matching host), but the Host header still carries
// the attacker's domain name.
export function createHostChecker ({ host, port }) {
	let hostnames = allowedHostnames(host);
	return function isOwnHost (hostHeader) {
		let url;
		try {
			url = new URL(`http://${hostHeader}`);
		} catch {
			return false;
		}
		let urlPort = Number(url.port || 80);
		return urlPort === Number(port) && hostnames.has(url.hostname.toLowerCase());
	};
}

// Express middleware: refuses every request (GET included) addressed to a
// host name that isn't this server's own. Browsers always send Host; a
// request without one can only come from a local non-browser client.
export function rejectForeignHost (isOwnHost) {
	return function (req, res, next) {
		let hostHeader = req.headers.host;
		if (hostHeader && !isOwnHost(hostHeader)) {
			res.status(421).json({ error: 'Unrecognized Host header' });
			return;
		}
		next();
	};
}

// Express middleware: refuses any state-changing request (anything but
// GET/HEAD/OPTIONS) coming from another origin. Browsers always send Origin
// on such fetches; Referer is the fallback for older ones. A request with
// neither header can't come from a web page, only from a local non-browser
// client (curl, a script), which already has the same access as this server.
export function rejectCrossOrigin (isOwnOrigin) {
	return function (req, res, next) {
		if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
			next();
			return;
		}
		let source = req.headers.origin || req.headers.referer;
		if (source && !isOwnOrigin(source)) {
			res.status(403).json({ error: 'Cross-origin request refused' });
			return;
		}
		next();
	};
}

// Express middleware for routes that read a JSON body: refuses anything else,
// so such a route can never be reached through a preflight-free cross-origin
// "simple" request (text/plain, form-encoded), as defense in depth on top of
// rejectCrossOrigin().
export function requireJson (req, res, next) {
	if (!req.is('application/json')) {
		res.status(415).json({ error: 'Expected an application/json body' });
		return;
	}
	next();
}
