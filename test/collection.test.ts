import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION_MARKER, deleteTree, hasCollectionResource, isCollection, listObjects } from '../src/collection.ts';

function r2Object(key: string): R2Object {
	return {
		key,
		version: 'v',
		size: 0,
		etag: '"e"',
		httpEtag: '"e"',
		uploaded: new Date(0),
		httpMetadata: {},
		customMetadata: {},
		checksums: {},
	} as R2Object;
}

test('isCollection reads the marker only', () => {
	assert.equal(isCollection({ resourcetype: COLLECTION_MARKER }), true);
	assert.equal(isCollection({ resourcetype: 'file' }), false);
	assert.equal(isCollection(undefined), false);
});

test('hasCollectionResource: marker, descendant, root, and missing', async () => {
	let withMarker = {
		head: async () => ({ customMetadata: { resourcetype: COLLECTION_MARKER } }),
	} as unknown as R2Bucket;
	assert.equal(await hasCollectionResource(withMarker, 'dir'), true);

	let withDescendant = {
		head: async () => null,
		list: async () => ({ objects: [r2Object('dir/x')] }),
	} as unknown as R2Bucket;
	assert.equal(await hasCollectionResource(withDescendant, 'dir'), true);

	let empty = {
		head: async () => null,
		list: async () => ({ objects: [] }),
	} as unknown as R2Bucket;
	assert.equal(await hasCollectionResource(empty, 'dir'), false);

	assert.equal(await hasCollectionResource(empty, ''), true);
});

test('listObjects walks paginated listings via the cursor', async () => {
	let page = 0;
	let bucket = {
		list: async () => {
			page += 1;
			if (page === 1) {
				return { objects: [r2Object('a'), r2Object('b')], truncated: true, cursor: 'c1' };
			}
			return { objects: [r2Object('c')], truncated: false };
		},
	} as unknown as R2Bucket;

	let keys: string[] = [];
	for await (let object of listObjects(bucket, '', true)) {
		keys.push(object.key);
	}
	assert.deepEqual(keys, ['a', 'b', 'c']);
});

test('deleteTree deletes in batches of 1000', async () => {
	let objects = Array.from({ length: 1001 }, (_, index) => r2Object(`k${index}`));
	let bucket = {
		list: async () => ({ objects, truncated: false }),
		delete: async (keys: string[]) => {
			deletions.push(keys.length);
			return keys;
		},
	} as unknown as R2Bucket;
	let deletions: number[] = [];

	await deleteTree(bucket, '');
	assert.deepEqual(deletions, [1000, 1]);
});

test('deleteTree leaves an empty subtree alone', async () => {
	let bucket = {
		list: async () => ({ objects: [], truncated: false }),
		delete: async () => {
			throw new Error('delete should not be called');
		},
	} as unknown as R2Bucket;
	await deleteTree(bucket, '');
});
