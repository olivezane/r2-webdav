/**
 * Resource tree helpers — path encoding, collection detection, and paginated traversal.
 */

export const COLLECTION_MARKER = '<collection />';

/** A resource is a collection when its custom metadata carries the collection marker. */
export function isCollection(customMetadata: Record<string, string> | undefined): boolean {
	return customMetadata?.resourcetype === COLLECTION_MARKER;
}

export function getResourceHref(key: string, isCollectionResource: boolean): string {
	const encodeHrefPath = (href: string): string => {
		if (href === '/') {
			return '/';
		}
		return href
			.split('/')
			.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
			.join('/');
	};

	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollectionResource ? '/' : '')}`);
}

export function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

export function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

export async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		return isCollection(resource.customMetadata);
	}

	let descendants = await bucket.list({
		prefix: resourcePath + '/',
		limit: 1,
	});
	return descendants.objects.length > 0;
}

/**
 * Yield every object under `prefix`, paginating the bucket listing.
 * Non-recursive listings use the delimiter (implicit collections only);
 * recursive listings walk the full subtree.
 */
export async function* listObjects(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	let listing: R2Objects;
	do {
		listing = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of listing.objects) {
			yield object;
		}

		if (listing.truncated) {
			cursor = listing.cursor;
		}
	} while (listing.truncated);
}

/** Delete a tree (all descendants plus the resource itself) in paginated batches. */
export async function deleteTree(bucket: R2Bucket, prefix: string): Promise<void> {
	let keys: string[] = [];
	for await (let object of listObjects(bucket, prefix, true)) {
		keys.push(object.key);
		if (keys.length >= 1000) {
			await bucket.delete(keys);
			keys = [];
		}
	}
	if (keys.length > 0) {
		await bucket.delete(keys);
	}
}
