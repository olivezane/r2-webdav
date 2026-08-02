import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcContentRange, serveObject } from '../src/content.ts';

function objectBody(range?: R2Range): R2ObjectBody {
	let body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('0123456789'));
			controller.close();
		},
	});
	return {
		key: 'file',
		version: 'v',
		size: 10,
		etag: '"etag"',
		httpEtag: '"etag"',
		uploaded: new Date(0),
		httpMetadata: {},
		customMetadata: {},
		range,
		body,
		checksums: {},
	} as R2ObjectBody;
}

function fakeBucket(
	respond: (opts: { onlyIf?: Headers; range?: Headers }) => R2Object | R2ObjectBody | null,
): R2Bucket {
	return {
		get: async (_key: string, opts: { onlyIf?: Headers; range?: Headers }) => respond(opts),
	} as unknown as R2Bucket;
}

test('calcContentRange handles all three R2 range shapes', () => {
	assert.deepEqual(calcContentRange(objectBody()), { rangeOffset: 0, rangeEnd: 9 });
	assert.deepEqual(calcContentRange(objectBody({ offset: 2, length: 3 })), { rangeOffset: 2, rangeEnd: 4 });
	assert.deepEqual(calcContentRange(objectBody({ offset: 8 })), { rangeOffset: 8, rangeEnd: 9 });
	assert.deepEqual(calcContentRange(objectBody({ suffix: 5 })), { rangeOffset: 5, rangeEnd: 9 });
});

test('calcContentRange clamps an oversized suffix range to the whole object', () => {
	assert.deepEqual(calcContentRange(objectBody({ suffix: 20 })), { rangeOffset: 0, rangeEnd: 9 });
});

test('calcContentRange treats a null suffix key as no range (regression: #22 suffix value check)', () => {
	// R2 can return the suffix key with a null value; must fall through to the whole object.
	assert.deepEqual(calcContentRange(objectBody({ suffix: null } as unknown as R2Range)), {
		rangeOffset: 0,
		rangeEnd: 9,
	});
});

test('GET without a Range header returns 200 with the full length (regression: non-Range GET was 206)', async () => {
	let bucket = fakeBucket(() => objectBody());
	let response = await serveObject(new Request('http://x/file'), bucket, 'file');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Length'), '10');
	assert.equal(response.headers.get('Content-Range'), null);
});

test('GET with a byte range returns 206 with Content-Range', async () => {
	let bucket = fakeBucket(() => objectBody({ offset: 2, length: 3 }));
	let response = await serveObject(new Request('http://x/file', { headers: { Range: 'bytes=2-4' } }), bucket, 'file');
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('Content-Range'), 'bytes 2-4/10');
	assert.equal(response.headers.get('Content-Length'), '3');
});

test('GET with a suffix range returns the tail (regression: suffix value handling)', async () => {
	let bucket = fakeBucket(() => objectBody({ suffix: 5 }));
	let response = await serveObject(new Request('http://x/file', { headers: { Range: 'bytes=-5' } }), bucket, 'file');
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('Content-Range'), 'bytes 5-9/10');
});

test('missing object returns 404', async () => {
	let bucket = fakeBucket(() => null);
	let response = await serveObject(new Request('http://x/file'), bucket, 'file');
	assert.equal(response.status, 404);
});
