/**
 * Content serving — maps a request plus an object into an HTTP response.
 * R2's three range shapes never leak out of this module.
 */

export type ContentRange = { rangeOffset: number; rangeEnd: number };

/** Translate R2's range shapes into byte offsets; oversized suffix ranges clamp to the whole object. */
export function calcContentRange(object: R2ObjectBody): ContentRange {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Also guard the value: R2 can return the suffix key with a null value (#22).
			if (object.range.suffix != null) {
				rangeOffset = Math.max(0, object.size - object.range.suffix);
			}
		} else {
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

const isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
	return 'body' in object;
};

/** Serve a single object's content (GET semantics); HEAD callers discard the body. */
export async function serveObject(request: Request, bucket: R2Bucket, resourcePath: string): Promise<Response> {
	let object = await bucket.get(resourcePath, {
		onlyIf: request.headers,
		range: request.headers,
	});

	if (object === null) {
		return new Response('Not Found', { status: 404 });
	} else if (!isR2ObjectBody(object)) {
		return new Response('Precondition Failed', { status: 412 });
	}

	const { rangeOffset, rangeEnd } = calcContentRange(object);
	const rangeRequested = request.headers.has('Range') && object.range !== undefined;

	if (rangeEnd < rangeOffset) {
		return new Response('Range Not Satisfiable', {
			status: 416,
			headers: { 'Content-Range': `bytes */${object.size}` },
		});
	}

	const contentLength = rangeEnd - rangeOffset + 1;
	return new Response(object.body, {
		status: rangeRequested ? 206 : 200,
		headers: {
			'Accept-Ranges': 'bytes',
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Content-Length': contentLength.toString(),
			...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
			...(object.httpMetadata?.contentDisposition
				? {
						'Content-Disposition': object.httpMetadata.contentDisposition,
					}
				: {}),
			...(object.httpMetadata?.contentEncoding
				? {
						'Content-Encoding': object.httpMetadata.contentEncoding,
					}
				: {}),
			...(object.httpMetadata?.contentLanguage
				? {
						'Content-Language': object.httpMetadata.contentLanguage,
					}
				: {}),
			...(object.httpMetadata?.cacheControl
				? {
						'Cache-Control': object.httpMetadata.cacheControl,
					}
				: {}),
			...(object.httpMetadata?.cacheExpiry
				? {
						'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
					}
				: {}),
		},
	});
}
