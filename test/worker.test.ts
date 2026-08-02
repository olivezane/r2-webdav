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
const bucket: R2Bucket = {
	put: async (key: string, value: ArrayBuffer, opts: { customMetadata?: Record<string, string> }) => {
		store.set(key, { key, size: (value as ArrayBuffer).byteLength, customMetadata: opts.customMetadata });
	},
	head: async (key: string) => {
		let stored = store.get(key);
		return stored ? storedObject(stored.key, stored.size, stored.customMetadata) : null;
	},
	get: async (key: string) => {
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
	},
	delete: async (keys: string | string[]) => {
		for (const key of typeof keys === 'string' ? [keys] : keys) {
			store.delete(key);
		}
		return keys;
	},
	list: async () => {
		throw new Error('list should not be reached in these scenarios');
	},
} as unknown as R2Bucket;

beforeEach(() => {
	store = new Map();
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
