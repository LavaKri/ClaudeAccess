// Single WebSocket connection to the server, shared by every message
// (prompts, aborts, pings), and kept alive across drops: the PC going to
// sleep, the server restarting, or a connection silently dying all close it
// eventually, and a plain `ws.send()` on a closed socket doesn't throw — the
// message is just discarded. So the connection is watched (close/error
// events, plus a periodic application-level ping, since the browser API
// can't send protocol-level ping frames) and reopened automatically, with a
// growing delay between failed attempts; send() also reopens it on demand
// rather than ever writing to a dead socket.

const RECONNECT_MIN_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
// A ping costs a few bytes: once a minute is negligible, and bounds how long
// a running response can wait on a connection that died without the browser
// noticing (send() checks the state itself anyway, so idle drops don't
// depend on this).
const PING_INTERVAL = 60000;
const PONG_TIMEOUT = 10000;
// How long send() waits for a reconnection before giving up.
const SEND_CONNECT_TIMEOUT = 5000;

let socket = null;
let onMessageHandler = () => {};
let onDisconnectHandler = () => {};
let reconnectDelay = RECONNECT_MIN_DELAY;
let reconnectTimer = null;
let pingTimer = null;
let pongTimer = null;

function stopPing () {
	clearInterval(pingTimer);
	clearTimeout(pongTimer);
	pingTimer = pongTimer = null;
}

function startPing (ws) {
	stopPing();
	pingTimer = setInterval(() => {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: 'ping' }));
		clearTimeout(pongTimer);
		pongTimer = setTimeout(() => dropSocket(ws, true), PONG_TIMEOUT);
	}, PING_INTERVAL);
}

function scheduleReconnect () {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		openSocket();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
}

// Forgets a socket that closed (or is presumed dead after a missed pong):
// detaches it first, so a late close event from a socket that was already
// replaced can't trigger a second disconnect/reconnect cycle. wasOpen tells
// a lost connection apart from a failed connection attempt.
function dropSocket (ws, wasOpen) {
	if (ws !== socket) return;
	socket = null;
	stopPing();
	try {
		ws.close();
	} catch {
		// Already closed: nothing to do.
	}
	if (wasOpen) onDisconnectHandler();
	scheduleReconnect();
}

function openSocket () {
	clearTimeout(reconnectTimer);
	reconnectTimer = null;

	let ws = new WebSocket(`ws://${location.host}/ws`);
	socket = ws;
	let opened = false;
	ws.addEventListener('open', () => {
		opened = true;
		reconnectDelay = RECONNECT_MIN_DELAY;
		startPing(ws);
	});
	ws.addEventListener('message', event => {
		let message = JSON.parse(event.data);
		if (message.type === 'pong') {
			clearTimeout(pongTimer);
			return;
		}
		onMessageHandler(message);
	});
	// An error is always followed by a close event, which does the cleanup.
	ws.addEventListener('close', () => dropSocket(ws, opened));
	return ws;
}

// Resolves with an open socket, reopening it right away if needed (rather
// than waiting for the next scheduled attempt), or rejects if that fails.
function ensureOpen () {
	let ws = socket;
	if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(ws);
	if (!ws || ws.readyState !== WebSocket.CONNECTING) ws = openSocket();

	return new Promise((resolve, reject) => {
		let timer = setTimeout(() => fail(), SEND_CONNECT_TIMEOUT);
		function cleanup () {
			clearTimeout(timer);
			ws.removeEventListener('open', succeed);
			ws.removeEventListener('close', fail);
		}
		function succeed () {
			cleanup();
			resolve(ws);
		}
		function fail () {
			cleanup();
			reject(new Error('WebSocket connection failed'));
		}
		ws.addEventListener('open', succeed);
		ws.addEventListener('close', fail);
	});
}

// onDisconnect is called whenever an open connection is lost (not on each
// failed reconnection attempt afterwards).
export function connect (onMessage, onDisconnect) {
	onMessageHandler = onMessage;
	if (onDisconnect) onDisconnectHandler = onDisconnect;
	if (!socket) openSocket();
}

// Rejects if the connection couldn't be (re)established: the caller must
// treat the payload as not sent.
export async function send (payload) {
	let ws = await ensureOpen();
	ws.send(JSON.stringify(payload));
}
