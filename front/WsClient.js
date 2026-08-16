// Lazily opens a single WebSocket connection to the server and reuses it for
// subsequent prompts, since the server currently spawns one CLI process per
// received message on that connection.

let socket = null;

function connect (onMessage) {
	if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);

	socket = new WebSocket(`ws://${location.host}/ws`);
	socket.addEventListener('message', event => onMessage(JSON.parse(event.data)));

	return new Promise((resolve, reject) => {
		socket.addEventListener('open', () => resolve(socket), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
	});
}

export async function sendPrompt (payload, onMessage) {
	let ws = await connect(onMessage);
	ws.send(JSON.stringify(payload));
}
