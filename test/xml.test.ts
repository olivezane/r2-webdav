import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml } from '../src/xml.ts';

test('escapeXml escapes the five XML special characters', () => {
	assert.equal(escapeXml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
	assert.equal(escapeXml('plain text'), 'plain text');
});
