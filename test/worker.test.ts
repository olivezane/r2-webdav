import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../src/index.ts';

type Stored = {
	key: string;
	size: number;
	customMetadata?: Record<string, string>;
};

function storedObject(key: string, size: number, customMetadata?: Record<string, string>): R2Object {
	return {
		key,
		version: 'v',
		size,
		etag: '"e"',
		httpEtag: '"e"',
		uploaded: new Date(0),
		httpMetadata: {},
		customMetadata,
		checksums: {},
	} as R2Object;
}

let store = new Map<string, Stored>();
let putValues: unknown[] = [];
let inflight = 0;
let maxInflight = 0;

async function track<T>(operation: () => Promise<T>): Promise<T> {
	inflight++;
	maxInflight = Math.max(maxInflight, inflight);
	try {
		// Simulate a network round-trip so overlapping operations actually pile up.
		await new Promise((resolve) => setTimeout(resolve, 0));
		return await operation();
	} finally {
		inflight--;
	}
}

async function streamByteLength(stream: ReadableStream): Promise<number> {
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
	}
	return total;
}

const bucket: R2Bucket = {
	put: async (key: string, value: ArrayBuffer | ReadableStream, opts: { customMetadata?: Record<string, string> }) =>
		track(async () => {
			putValues.push(value);
			let size = value instanceof ReadableStream ? await streamByteLength(value) : value.byteLength;
			store.set(key, { key, size, customMetadata: opts.customMetadata });
		}),
	head: async (key: string) => {
		let stored = store.get(key);
		return stored ? storedObject(stored.key, stored.size, stored.customMetadata) : null;
	},
	get: async (key: string) =>
		track(async () => {
			let stored = store.get(key);
			if (!stored) {
				return null;
			}
			let object = storedObject(stored.key, stored.size, stored.customMetadata);
			return {
				...object,
				body: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
			} as R2ObjectBody;
		}),
	delete: async (keys: string | string[]) =>
		track(async () => {
			for (const key of typeof keys === 'string' ? [keys] : keys) {
				store.delete(key);
			}
			return keys;
		}),
	list: async (opts: { prefix?: string; delimiter?: string; cursor?: string }) => {
		let prefix = opts.prefix ?? '';
		let objects: R2Object[] = [];
		let delimitedPrefixes: string[] = [];
		for (const key of [...store.keys()].sort()) {
			if (!key.startsWith(prefix)) {
				continue;
			}
			let remainder = key.slice(prefix.length);
			if (opts.delimiter !== undefined && remainder.includes('/')) {
				let delimited = prefix + remainder.split('/')[0] + '/';
				if (!delimitedPrefixes.includes(delimited)) {
					delimitedPrefixes.push(delimited);
				}
				continue;
			}
			let stored = store.get(key)!;
			objects.push(storedObject(stored.key, stored.size, stored.customMetadata));
		}
		return { objects, delimitedPrefixes, truncated: false } as R2Objects;
	},
} as unknown as R2Bucket;

beforeEach(() => {
	store = new Map();
	putValues = [];
	inflight = 0;
	maxInflight = 0;
});

const env = { bucket, USERNAME: 'test', PASSWORD: 'test' } as unknown as Env;
const AUTH = { Authorization: 'Basic ' + btoa('test:test') };

function call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
	return worker.fetch(
		new Request(`http://x${path}`, { method, ...init, headers: { ...AUTH, ...(init.headers ?? {}) } }),
		env,
		{} as ExecutionContext,
	);
}

test('PUT without conditional headers streams the body to R2 instead of buffering it', async () => {
	let response = await call('PUT', '/streamed.txt', { body: 'hello' });
	assert.equal(response.status, 201);
	assert.equal(store.get('streamed.txt')?.size, 5);
	assert.ok(putValues[putValues.length - 1] instanceof ReadableStream);
});

test('PUT with a conditional header buffers the body so onlyIf semantics are unchanged', async () => {
	assert.equal((await call('PUT', '/cond.txt', { body: 'x' })).status, 201);

	let response = await call('PUT', '/cond.txt', { headers: { 'If-None-Match': '"missing"' }, body: 'y' });
	assert.equal(response.status, 204);
	assert.ok(putValues[putValues.length - 1] instanceof ArrayBuffer);
});

test('PUT on an existing collection is rejected with 405 instead of corrupting its marker', async () => {
	assert.equal((await call('MKCOL', '/dir')).status, 201);

	let response = await call('PUT', '/dir', { body: 'not a directory' });
	assert.equal(response.status, 405);
	assert.equal(store.get('dir')?.customMetadata?.resourcetype, '<collection />');
	assert.equal(store.get('dir')?.size, 0);
});

test('basic auth accepts non-ASCII credentials encoded as UTF-8', async () => {
	let unicodeEnv = { bucket, USERNAME: '用户', PASSWORD: '密码✓' } as unknown as Env;
	let header = 'Basic ' + Buffer.from('用户:密码✓', 'utf8').toString('base64');

	let accepted = await worker.fetch(
		new Request('http://x/missing.txt', { headers: { Authorization: header } }),
		unicodeEnv,
		{} as ExecutionContext,
	);
	// 404 means the request passed auth and reached the handler for a missing resource.
	assert.equal(accepted.status, 404);

	let rejected = await worker.fetch(
		new Request('http://x/', {
			headers: { Authorization: 'Basic ' + Buffer.from('用户:wrong', 'utf8').toString('base64') },
		}),
		unicodeEnv,
		{} as ExecutionContext,
	);
	assert.equal(rejected.status, 401);
});

test('directory listing is served for a collection URL with a query string', async () => {
	assert.equal((await call('MKCOL', '/dir')).status, 201);

	let response = await call('GET', '/dir/?q=1');
	assert.equal(response.status, 200);
	assert.match(await response.text(), /R2 Storage/);
});

test('recursive COPY bounds concurrent R2 operations while copying every object', async () => {
	assert.equal((await call('MKCOL', '/big')).status, 201);
	for (let i = 0; i < 120; i++) {
		assert.equal((await call('PUT', `/big/f${String(i).padStart(3, '0')}`, { body: 'x' })).status, 201);
	}

	let response = await call('COPY', '/big', { headers: { Destination: 'http://x/big-copy' } });
	assert.equal(response.status, 201);
	assert.ok(maxInflight <= 50, `concurrency reached ${maxInflight}`);
	for (let i = 0; i < 120; i++) {
		assert.ok(store.has(`big-copy/f${String(i).padStart(3, '0')}`), `missing copy f${i}`);
	}
});

test('PROPFIND rejects an invalid Depth header with 400', async () => {
	assert.equal((await call('PUT', '/p.txt', { body: 'x' })).status, 201);

	let response = await call('PROPFIND', '/p.txt', { headers: { Depth: 'bogus' } });
	assert.equal(response.status, 400);
});

test('PROPFIND Depth: infinity returns every descendant in the subtree', async () => {
	await call('MKCOL', '/tree');
	await call('PUT', '/tree/f1', { body: '1' });
	await call('MKCOL', '/tree/sub');
	await call('PUT', '/tree/sub/f2', { body: '2' });

	let response = await call('PROPFIND', '/tree', { headers: { Depth: 'infinity' } });
	assert.equal(response.status, 207);
	let text = await response.text();
	assert.equal((text.match(/<response>/g) ?? []).length, 4); // tree + f1 + sub + sub/f2
	assert.match(text, /tree\/sub\/f2/);
});

const LOCK_BODY =
	'<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope><locktype><write/></locktype><owner>t</owner></lockinfo>';

async function lock(path: string): Promise<string> {
	let response = await call('LOCK', path, {
		headers: { Timeout: 'Second-3600', 'Content-Type': 'application/xml' },
		body: LOCK_BODY,
	});
	assert.equal(response.status, 201);
	// The header is `<urn:uuid:<token>>`; normalize like the worker does.
	let token = (response.headers.get('Lock-Token') ?? '').replace(/[<>]/g, '').replace(/^urn:uuid:/, '');
	return token;
}

test('PUT after LOCK: 423 without token, 204 with token, lock preserved', async () => {
	assert.equal((await call('PUT', '/locked.txt', { body: 'one' })).status, 201);
	let token = await lock('/locked.txt');

	assert.equal((await call('PUT', '/locked.txt', { body: 'two' })).status, 423);

	let response = await call('PUT', '/locked.txt', { headers: { If: `(<urn:uuid:${token}>)` }, body: 'three' });
	assert.equal(response.status, 204);
	assert.ok(store.get('locked.txt')?.customMetadata?.lock_records?.includes(token));
});

test('MOVE preserves locks on the destination', async () => {
	let token = await lock('/locked.txt');

	let response = await call('MOVE', '/locked.txt', {
		headers: { Destination: 'http://x/moved.txt', If: `(<urn:uuid:${token}>)` },
	});
	assert.equal(response.status, 201);
	assert.ok(store.get('moved.txt')?.customMetadata?.lock_records?.includes(token));
	assert.equal(store.has('locked.txt'), false);
});

test('COPY strips locks from the copy', async () => {
	assert.equal((await call('PUT', '/source.txt', { body: 'x' })).status, 201);
	let token = await lock('/source.txt');

	let response = await call('COPY', '/source.txt', { headers: { Destination: 'http://x/copied.txt' } });
	assert.equal(response.status, 201);
	let metadata = store.get('copied.txt')?.customMetadata ?? {};
	assert.equal(metadata.lock_records, undefined);
	assert.equal(metadata.lock_token, undefined);
	// The source keeps its own lock.
	assert.ok(store.get('source.txt')?.customMetadata?.lock_records?.includes(token));
});
