const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function toBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function fromBase64Url(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
		throw new Error("Invalid object key encoding");
	}

	const padded =
		value.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeObjectKey(key: string) {
	return toBase64Url(encoder.encode(key));
}

export function decodeObjectKey(encoded: string) {
	try {
		const key = decoder.decode(fromBase64Url(encoded));
		if (encodeObjectKey(key) !== encoded)
			throw new Error("Non-canonical object key encoding");
		return key;
	} catch {
		throw new Error("Invalid object key encoding");
	}
}
