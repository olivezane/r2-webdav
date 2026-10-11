import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../src/index.ts';

type Obj = { body: Uint8Array; httpMetadata?: Record<string, string>; customMetadata: Record<string, string> };

function fakeBucket(seed: Record<string, Obj> = {}) {
	let store = new Map(Object.entries(seed));
	return {
		store,
		del: (k: string) => store.delete(k),
		async head(key: string) {
			let o = store.get(key);
			if (o === undefined) return null;
			return {
				key,
				size: o.body.length,
				etag: 'e',
				uploaded: new Date(0),
				customMetadata: o.customMetadata,
				httpMetadata: o.httpMetadata,
				writeHttpMetadata() {},
			};
		},
		async get(key: string, opts?: { range?: Headers }) {
			let o = store.get(key);
			if (o === undefined) return null;
			let range: any = undefined;
			let header = opts?.range?.get?.('Range');
			if (header) {
				let m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
				if (m) {
					if (m[1] === '') range = { suffix: Number(m[2]) };
					else if (m[2] === '') range = { offset: Number(m[1]) };
					else range = { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
				}
			}
			let slice = o.body;
			if (range) {
				if ('suffix' in range) slice = o.body.slice(Math.max(o.body.length - range.suffix, 0));
				else if (range.length === undefined) slice = o.body.slice(range.offset);
				else slice = o.body.slice(range.offset, range.offset + range.length);
			}
			return {
				key,
				size: o.body.length,
				etag: 'e',
				uploaded: new Date(0),
				customMetadata: o.customMetadata,
				httpMetadata: o.httpMetadata,
				body: slice,
				range,
				writeHttpMetadata() {},
			};
		},
		async put(key: string, value: Uint8Array | ReadableStream, opts?: any) {
			let body = value instanceof Uint8Array ? value : new Uint8Array();
			store.set(key, { body, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata ?? {} });
			return this.head(key);
		},
		async delete(key: string) {
			store.delete(key);
		},
		list(opts: { prefix?: string; cursor?: string } = {}) {
			let objects = [...store.entries()]
				.filter(([k]) => k.startsWith(opts.prefix ?? ''))
				.map(([k, o]) => ({ key: k, size: o.body.length, customMetadata: o.customMetadata }));
			return Promise.resolve({ objects, truncated: false });
		},
	} as unknown as R2Bucket & { store: Map<string, Obj>; del: (k: string) => boolean };
}

const ENV = { USERNAME: 'u', PASSWORD: 'p' } as Env;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
const BASE = 'https://webdav.ownland.top';

async function call(bucket: R2Bucket, path: string, init: RequestInit = {}) {
	let headers = new Headers(init.headers);
	headers.set('Authorization', AUTH);
	if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/xml');
	return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), { ...ENV, bucket }, {} as any);
}

const COLLECTION = { body: new Uint8Array(), customMetadata: { resourcetype: '<collection />' } };

test('漏洞1: 死属性里的元素/CDATA 不再逃逸出属性元素', async () => {
	let forged =
		'<response><href>/FORGED</href><propstat><prop><getcontentlength>999999</getcontentlength></prop></propstat></response>';
	let bucket = fakeBucket({
		'': COLLECTION,
		'a.txt': {
			body: new TextEncoder().encode('hi'),
			customMetadata: {
				'dead_property:DAV%3A:x': JSON.stringify({
					namespaceURI: 'DAV:',
					localName: 'x',
					prefix: null,
					valueXml: forged,
				}),
				'dead_property:DAV%3A:y': JSON.stringify({
					namespaceURI: 'DAV:',
					localName: 'y',
					prefix: null,
					valueXml: '<![CDATA[' + forged + ']]>',
				}),
			},
		},
	});
	let res = await call(bucket, '/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
	let body = await res.text();
	assert.equal(res.status, 207);
	assert.ok(!body.includes('<response><href>/FORGED'), '不得出现伪造的 response 元素');
	assert.ok(!body.includes('<![CDATA['), '不得出现 CDATA');
	assert.ok(body.includes('&lt;response&gt;'), '应转义为文本');
});

test('漏洞1b: customMetadata 里的坏 JSON 不再让 PROPFIND 500', async () => {
	let bucket = fakeBucket({
		'': COLLECTION,
		'a.txt': {
			body: new Uint8Array(),
			customMetadata: {
				'dead_property:DAV%3A:bad': '{not json',
				'dead_property:DAV%3A:missing': '{"namespaceURI":"DAV:"}',
			},
		},
	});
	let res = await call(bucket, '/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
	assert.equal(res.status, 207);
});

test('漏洞2: 原型链属性名不再 500', async () => {
	let bucket = fakeBucket({ '': COLLECTION, 'a.txt': { body: new Uint8Array(), customMetadata: {} } });
	for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
		let res = await call(bucket, '/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
			body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:${name}/></D:prop></D:propfind>`,
		});
		assert.equal(res.status, 207, `${name} 应返回 207`);
	}
});

test('漏洞3: 越界 Range 不再 500,空对象返回 416', async () => {
	let bucket = fakeBucket({ '': COLLECTION, 'empty.txt': { body: new Uint8Array(), customMetadata: {} } });
	let res = await call(bucket, '/empty.txt', { headers: { Range: 'bytes=100-200' } });
	assert.equal(res.status, 416);
	assert.equal(res.headers.get('Content-Range'), 'bytes */0');

	let bucket2 = fakeBucket({
		'': COLLECTION,
		'f.txt': { body: new TextEncoder().encode('hello'), customMetadata: {} },
	});
	let ok = await call(bucket2, '/f.txt', { headers: { Range: 'bytes=0-1' } });
	assert.equal(ok.status, 206);
	assert.equal(ok.headers.get('Content-Range'), 'bytes 0-1/5');
	assert.equal(await ok.text(), 'he');
});

test('漏洞4: Timeout: Infinite 被钳到 24 小时且不再自动 depth:infinity', async () => {
	let bucket = fakeBucket({ '': COLLECTION, sub: COLLECTION, sub2: COLLECTION });
	let body =
		'<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>me</D:owner></D:lockinfo>';
	let res = await call(bucket, '/sub/', { method: 'LOCK', headers: { Timeout: 'Infinite' }, body });
	assert.equal(res.status, 201);
	let xml = await res.text();
	assert.ok(xml.includes('<timeout>Second-86400</timeout>'), `实际: ${xml}`);
	assert.ok(!xml.includes('Infinite'), '不得再出现 Infinite');
	assert.ok(xml.includes('<depth>infinity</depth>'), 'RFC 4918 要求 LOCK 无 Depth 头时默认 infinity,此处保持不变');

	// 带命名空间前缀的 lockinfo 现在也应被接受
	let prefixed = await call(bucket, '/sub2/', {
		method: 'LOCK',
		headers: { Timeout: 'Second-60' },
		body: body.replaceAll('D:', 'Z:').replace('xmlns:D=', 'xmlns:Z='),
	});
	assert.equal(prefixed.status, 201);
});

test('漏洞6: 元数据超限返回 507 且不写坏对象', async () => {
	let bucket = fakeBucket({ '': COLLECTION, 'a.txt': { body: new TextEncoder().encode('x'), customMetadata: {} } });
	let props = '';
	for (let i = 0; i < 200; i++) props += `<Z:p${i}>${'A'.repeat(200)}</Z:p${i}>`;
	let res = await call(bucket, '/a.txt', {
		method: 'PROPPATCH',
		body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:z"><D:set><D:prop>${props}</D:prop></D:set></D:propertyupdate>`,
	});
	assert.equal(res.status, 507);
	let stored = (bucket as any).store.get('a.txt');
	assert.equal(Object.keys(stored.customMetadata).length, 0, '超限时不应写入任何属性');

	// 正常量级仍然成功
	let small = await call(bucket, '/a.txt', {
		method: 'PROPPATCH',
		body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:z"><D:set><D:prop><Z:ok>yes</Z:ok></D:prop></D:set></D:propertyupdate>`,
	});
	assert.equal(small.status, 207);
	assert.ok((bucket as any).store.get('a.txt').customMetadata['dead_property:urn%3Az:ok']);
});

test('漏洞4b: 锁数量上限 20', async () => {
	let bucket = fakeBucket({ '': COLLECTION, 'a.txt': { body: new Uint8Array(), customMetadata: {} } });
	let body =
		'<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><shared/></lockscope><locktype><write/></locktype></lockinfo>';
	for (let i = 0; i < 25; i++) {
		let res = await call(bucket, '/a.txt', { method: 'LOCK', headers: { Timeout: 'Second-60' }, body });
		assert.ok(res.status === 201 || res.status === 207, `第 ${i} 次 LOCK 返回 ${res.status}`);
	}
	let records = JSON.parse((bucket as any).store.get('a.txt').customMetadata['lock_records']);
	assert.ok(records.length <= 20, `锁记录应被裁剪,实际 ${records.length}`);
});

test('漏洞5: CORS 不再反射任意 Origin', async () => {
	let bucket = fakeBucket({ '': COLLECTION });
	let evil = await call(bucket, '/', { headers: { Origin: 'https://evil.example' } });
	assert.equal(evil.headers.get('Access-Control-Allow-Origin'), '*');
	assert.equal(evil.headers.get('Access-Control-Allow-Credentials'), 'false');
	let self = await call(bucket, '/', { headers: { Origin: BASE } });
	assert.equal(self.headers.get('Access-Control-Allow-Origin'), BASE);
});

test('顶层兜底: 未捕获异常返回 500 而不是抛出去', async () => {
	let bucket = fakeBucket();
	(bucket as any).head = async () => {
		throw new Error('boom');
	};
	let res = await call(bucket, '/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
	assert.equal(res.status, 500);
});
