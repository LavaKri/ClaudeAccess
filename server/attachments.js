// Files attached to the next prompt. Uploaded one by one as soon as the user
// picks them (so a wrong one can be removed before sending), kept in memory
// here until the prompt that uses them is actually written to claude, then
// sent inline in that user message as API content blocks — never written to
// disk. Only what Claude can read directly that way is accepted:
// - images (PNG, JPEG, GIF, WebP) and PDFs, recognized by their signature
//   (the API rejects an image whose declared media type doesn't match its
//   content, so the file extension is never trusted);
// - text, in any 8-bit encoding or UTF-16 with a BOM (see decodeText()).
// Everything else (Office documents, archives, audio...) is refused.
//
// This store is only a cache: the browser keeps the original files and
// uploads them again whenever the server reports one missing (expired, or
// lost with a server restart). So an attachment never sent is simply
// forgotten after a while, rather than kept in memory indefinitely.

import { randomUUID } from 'node:crypto';

// id -> { id, name, size, kind, blocks, timer }
const store = new Map();

const IMAGE_SIGNATURES = [
	{ mediaType: 'image/png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
	{ mediaType: 'image/jpeg', test: b => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
	{ mediaType: 'image/gif', test: b => ['GIF87a', 'GIF89a'].includes(b.toString('latin1', 0, 6)) },
	{ mediaType: 'image/webp', test: b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

// The PDF spec tolerates junk before the header, within the first 1024 bytes.
function isPdf (buffer) {
	return buffer.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
}

// Control characters allowed in a text file: tab, LF, form feed, CR, and ESC
// (ANSI color codes in logs). Any other one, NUL included, means binary.
const FORBIDDEN_CONTROL_CHARS = /[\x00-\x08\x0B\x0E-\x1A\x1C-\x1F]/;

// Decodes a file as text, or returns null if it doesn't look like text.
// UTF-16 is only recognized by its BOM (it's full of NUL bytes otherwise).
// Without a BOM, valid UTF-8 is taken as such, and anything else as
// Windows-1252 — the superset of ISO-8859-1 that Windows actually uses
// (€, typographic quotes... where ISO-8859-1 has invisible C1 controls).
function decodeText (buffer) {
	let text;
	if (buffer[0] === 0xFF && buffer[1] === 0xFE) text = new TextDecoder('utf-16le').decode(buffer);
	else if (buffer[0] === 0xFE && buffer[1] === 0xFF) text = new TextDecoder('utf-16be').decode(buffer);
	else {
		try {
			// Strips a UTF-8 BOM by default.
			text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
		} catch {
			text = new TextDecoder('windows-1252').decode(buffer);
		}
	}
	return FORBIDDEN_CONTROL_CHARS.test(text) ? null : text;
}

// Builds the content blocks sent to claude for one file, or returns
// { error } with a code the front end translates: 'empty' | 'unsupported'.
// An image block has no field for its file name, hence the text block
// before it; documents carry it as their title.
function toBlocks (name, buffer) {
	if (!buffer.length) return { error: 'empty' };
	let image = IMAGE_SIGNATURES.find(signature => signature.test(buffer));
	if (image) {
		return { kind: 'image', blocks: [
			{ type: 'text', text: `Attachment: ${name}` },
			{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: buffer.toString('base64') } },
		] };
	}
	if (isPdf(buffer)) {
		return { kind: 'pdf', blocks: [
			{ type: 'document', title: name, source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
		] };
	}
	let text = decodeText(buffer);
	if (text === null) return { error: 'unsupported' };
	return { kind: 'text', blocks: [
		{ type: 'document', title: name, source: { type: 'text', media_type: 'text/plain', data: text } },
	] };
}

// Returns { id, name, size, kind } for an accepted file, or { error }.
// Forgotten after ttlMs if not sent by then.
export function addAttachment (name, buffer, ttlMs) {
	let { error, kind, blocks } = toBlocks(name, buffer);
	if (error) return { error };
	let attachment = { id: randomUUID(), name, size: buffer.length, kind, blocks };
	attachment.timer = setTimeout(() => store.delete(attachment.id), ttlMs);
	// A pending expiry mustn't keep the server process alive on shutdown.
	attachment.timer.unref();
	store.set(attachment.id, attachment);
	return describe(attachment);
}

export function deleteAttachment (id) {
	clearTimeout(store.get(id)?.timer);
	return store.delete(id);
}

function describe ({ id, name, size, kind }) {
	return { id, name, size, kind };
}

// Ids among the given ones that aren't (or no longer) in the store: expired,
// lost with a server restart, or already sent. A prompt must not go out
// without them: the client uploads them again first.
export function missingAttachments (ids) {
	return ids.filter(id => !store.has(id));
}

// Content blocks for the given attachment ids, in that order. All of them
// must exist (see missingAttachments).
export function attachmentBlocks (ids) {
	return ids.flatMap(id => store.get(id).blocks);
}

// Called once the prompt using them has been written to claude.
export function releaseAttachments (ids) {
	for (let id of ids) deleteAttachment(id);
}
