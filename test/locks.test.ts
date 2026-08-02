import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	getLocks,
	isProtectedProperty,
	MAX_LOCK_TIMEOUT,
	normalizeLockToken,
	parseLockTimeout,
	preserveLocks,
	stripLockMetadata,
} from '../src/locks.ts';

const FUTURE = String(Date.now() + 60_000);

test('normalizeLockToken strips angle brackets and uuid prefixes', () => {
	assert.equal(normalizeLockToken('<urn:uuid:abc123>'), 'abc123');
	assert.equal(normalizeLockToken('opaquelocktoken:xyz'), 'xyz');
	assert.equal(normalizeLockToken('  plain  '), 'plain');
});

test('parseLockTimeout defaults, parses, and clamps', () => {
	let parsed = parseLockTimeout(null);
	assert.equal(parsed.timeout, 'Second-3600');
	assert.ok(Math.abs(parsed.expiresAt - (Date.now() + 3600_000)) < 1000);

	assert.equal(parseLockTimeout('Second-120').timeout, 'Second-120');
	assert.equal(parseLockTimeout('infinite').timeout, 'Infinite');
	assert.ok(Math.abs(parseLockTimeout('infinite').expiresAt - (Date.now() + MAX_LOCK_TIMEOUT * 1000)) < 1000);
	assert.equal(parseLockTimeout('Second-99999999').timeout, `Second-${MAX_LOCK_TIMEOUT}`);
	assert.equal(parseLockTimeout('Second-0, Second-500').timeout, 'Second-500');
});

test('getLocks reads the legacy single-lock format and drops expired locks', () => {
	let locks = getLocks({
		lock_token: '<urn:uuid:abc>',
		lock_scope: 'exclusive',
		lock_depth: 'infinity',
		lock_expires_at: FUTURE,
	});
	assert.equal(locks.length, 1);
	// Legacy tokens are stored as-is; normalization applies to incoming request tokens.
	assert.equal(locks[0].token, '<urn:uuid:abc>');
	assert.equal(locks[0].depth, 'infinity');

	assert.deepEqual(getLocks({ lock_token: 'abc', lock_expires_at: '1000' }), []);
});

test('getLocks reads the lock_records format', () => {
	let locks = getLocks({
		lock_records: JSON.stringify([
			{ token: 'one', scope: 'exclusive', depth: '0', expiresAt: Number(FUTURE) },
			{ token: 'two', scope: 'shared', depth: 'infinity', expiresAt: Number(FUTURE) },
		]),
	});
	assert.equal(locks.length, 2);
	assert.equal(locks[0].token, 'one');
	assert.equal(locks[1].scope, 'shared');
});

test('preserveLocks carries active locks over and strips lock keys when none remain', () => {
	let metadata = {
		'dead_property:custom': '{}',
		lock_token: 'abc',
		lock_expires_at: FUTURE,
	};
	let preserved = preserveLocks(metadata);
	assert.equal(preserved['dead_property:custom'], '{}');
	assert.equal(preserved.lock_token, undefined);
	assert.ok(preserved.lock_records?.includes('abc'));

	let stripped = preserveLocks({ lock_token: 'abc', lock_expires_at: '1000' }); // expired (epoch ms)
	assert.equal(stripped.lock_token, undefined);
	assert.equal(stripped.lock_records, undefined);
});

test('stripLockMetadata removes every lock key', () => {
	let stripped = stripLockMetadata({
		lock_token: 'a',
		lock_records: '[]',
		'dead_property:x': '{}',
	});
	assert.deepEqual(Object.keys(stripped), ['dead_property:x']);
});

test('isProtectedProperty covers lock keys and lock-discovery properties', () => {
	assert.equal(isProtectedProperty('lock_token'), true);
	assert.equal(isProtectedProperty('lockdiscovery'), true);
	assert.equal(isProtectedProperty('supportedlock'), true);
	assert.equal(isProtectedProperty('getcontentlength'), false);
	assert.equal(isProtectedProperty({ localName: 'lock_root' }), true);
});
