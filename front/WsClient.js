// Opens a single WebSocket connection to the server on first use and reuses
// it for every message afterwards (prompts, aborts, and future message types).

let socket = null;
let ready = null;

export function connect (onMessage) {
	if (ready) return ready;

	socket = new WebSocket(`ws://${location.host}/ws`);
	socket.addEventListener('message', event => onMessage(JSON.parse(event.data)));

	ready = new Promise((resolve, reject) => {
		socket.addEventListener('open', () => resolve(socket), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
	});
	return ready;
}

export async function send (payload) {
	let ws = await ready;
	ws.send(JSON.stringify(payload));
}
