/**
 * r2-webdav — WebDAV server over Cloudflare R2.
 *
 * Module layout:
 * - collection.ts — resource tree: path encoding, collection detection, paginated traversal
 * - locks.ts       — lock storage and lock-token semantics
 * - content.ts     — GET/HEAD content serving and range translation
 * - xml.ts         — XML text escaping
 */

import { DOMParser } from '@xmldom/xmldom';
import {
	COLLECTION_MARKER,
	decodeResourcePath,
	deleteTree,
	getParentPath,
	getResourceHref,
	hasCollectionResource,
	isCollection,
	listObjects,
} from './collection.ts';
import { escapeXml } from './xml.ts';
import {
	determineLockDepth,
	extractLockOwner,
	findMatchingLock,
	getLockDiscovery,
	getLocks,
	getRequestLockTokens,
	isProtectedProperty,
	LockDetails,
	normalizeLockToken,
	parseLockTimeout,
	preserveLocks,
	requireLockPermission,
	requireRecursiveDeletePermission,
	stripLockMetadata,
	VALID_LOCK_DEPTHS,
	writeLocks,
} from './locks.ts';
import { serveHead, serveObject } from './content.ts';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};

const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const DAV_NAMESPACE = 'DAV:';
const DEAD_PROPERTY_PREFIX = 'dead_property:';

function makeResourcePath(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function createdResponse(
	resourcePath: string,
	isCollectionResource: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollectionResource));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return JSON.parse(value) as DeadProperty;
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => JSON.parse(value) as DeadProperty);
}

function renderPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration} />`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let propfindChildren = getChildElements(document.documentElement);
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = propfindChildren.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return {
			mode: 'prop',
			properties: properties as DeadProperty[],
		};
	}
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getSupportedLock(): string {
	return [
		'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>',
		'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>',
	].join('');
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: COLLECTION_MARKER,
			supportedlock: getSupportedLock(),
			lockdiscovery: '',
		};
	}

	let isCollectionResource = isCollection(object.customMetadata);
	let lockDetails = getLocks(object.customMetadata);
	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: getSupportedLock(),
		lockdiscovery:
			lockDetails.length === 0
				? ''
				: getLockDiscovery(
						lockDetails.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(object.key, isCollectionResource),
						})),
					),
	};
}

function getLivePropertyValue(object: R2Object | null, property: DeadProperty): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromR2Object(object)[property.localName as keyof DavProperties];
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

function generatePropfindResponse(object: R2Object | null, propfindRequest: PropfindRequest): string {
	let href = object === null ? '/' : getResourceHref(object.key, isCollection(object.customMetadata));
	let deadProperties = getDeadProperties(object?.customMetadata);
	let liveProperties = Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map((property) => renderEmptyPropertyElement({ ...property, valueXml: '' })),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(object, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
				}
			}
			break;
		}
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handleGet(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);

	if (request.url.endsWith('/')) {
		if (resourcePath !== '') {
			let resource = await bucket.head(resourcePath);
			if (resource === null || !isCollection(resource.customMetadata)) {
				return new Response('Not Found', { status: 404 });
			}
		}

		let page = '',
			prefix = resourcePath;
		if (resourcePath !== '') {
			page += `<a href="../">..</a><br>`;
			prefix = `${resourcePath}/`;
		}

		for await (const object of listObjects(bucket, prefix)) {
			if (object.key === resourcePath) {
				continue;
			}
			let href = getResourceHref(object.key, isCollection(object.customMetadata));
			page += `<a href="${escapeXml(href)}">${escapeXml(
				object.httpMetadata?.contentDisposition ?? object.key.slice(prefix.length),
			)}</a><br>`;
		}
		let pageSource = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href="../"]{background-color:#cbd5e1;}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`;

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		return serveObject(bucket, request, resourcePath);
	}
}

async function handleHead(request: Request, bucket: R2Bucket): Promise<Response> {
	return serveHead(bucket, request, makeResourcePath(request));
}

async function handlePut(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await requireLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}
	let existing = await bucket.head(resourcePath);

	// Check if the parent directory exists
	let dirpath = getParentPath(resourcePath);
	if (!(await hasCollectionResource(bucket, dirpath))) {
		return new Response('Conflict', { status: 409 });
	}

	let body = await request.arrayBuffer();
	await bucket.put(resourcePath, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: preserveLocks(existing?.customMetadata),
	});
	return existing === null ? new Response('', { status: 201 }) : new Response(null, { status: 204 });
}

async function handleDelete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let lockResponse = await requireRecursiveDeletePermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resourcePath === '') {
		await deleteTree(bucket, '');
		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (!isCollection(resource.customMetadata)) {
		await bucket.delete(resourcePath);
		return new Response(null, { status: 204 });
	}

	await deleteTree(bucket, resourcePath + '/');
	await bucket.delete(resourcePath);
	return new Response(null, { status: 204 });
}

async function handleMkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resourcePath = makeResourcePath(request);
	let lockResponse = await requireLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists
	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parentDir = getParentPath(resourcePath);
	if (!(await hasCollectionResource(bucket, parentDir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resourcePath, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: COLLECTION_MARKER },
	});
	return new Response('', { status: 201 });
}

async function handlePropfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	let isCollectionResource: boolean;
	if (resourcePath === '') {
		page += generatePropfindResponse(null, propfindRequest);
		isCollectionResource = true;
	} else {
		let object = await bucket.head(resourcePath);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		isCollectionResource = isCollection(object.customMetadata);
		page += generatePropfindResponse(object, propfindRequest);
	}

	if (isCollectionResource) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resourcePath === '' ? resourcePath : resourcePath + '/';
					for await (let object of listObjects(bucket, prefix)) {
						page += generatePropfindResponse(object, propfindRequest);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resourcePath === '' ? resourcePath : resourcePath + '/';
					for await (let object of listObjects(bucket, prefix, true)) {
						page += generatePropfindResponse(object, propfindRequest);
					}
				}
				break;
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handleProppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resourcePath = makeResourcePath(request);
	let lockResponse = await requireLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let object = await bucket.head(resourcePath);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const body = await request.text();
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}
	const { operations } = parsedRequest;

	// Copy the existing custom metadata
	const customMetadata = preserveLocks(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// Update metadata
	for (const operation of operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}
		if (operation.action === 'set') {
			customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
				JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			successfulRemoveProperties.push(operation.property);
		}
	}

	const hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		// Update the object's metadata
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// Build the response
	let propstats = new Map<string, string[]>();
	const appendPropstat = (property: DeadProperty, status: string) => {
		let props = propstats.get(status) ?? [];
		props.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
		propstats.set(status, props);
	};
	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';

	for (const property of successfulSetProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of successfulRemoveProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of failedSetProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	for (const property of failedRemoveProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, isCollection(object.customMetadata)))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handleCopy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let dontOverwrite = request.headers.get('Overwrite') === 'F';
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resourcePath, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await requireLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destinationParent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destinationParent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destinationExists = await bucket.head(destination);
	if (dontOverwrite && destinationExists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let isDir = isCollection(resource.customMetadata);

	if (isDir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resourcePath + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: stripLockMetadata(object.customMetadata),
						});
					}
				};
				let promiseArray = [copy(resource)];
				for await (let object of listObjects(bucket, prefix, true)) {
					promiseArray.push(copy(object));
				}
				await Promise.all(promiseArray);
				if (destinationExists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: stripLockMetadata(object.customMetadata),
				});
				if (destinationExists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destinationExists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handleMove(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destinationHeader = request.headers.get('Destination');
	if (destinationHeader === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destinationHeader, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resourcePath, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await requireLockPermission(request, bucket, resourcePath);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await requireLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destinationParent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destinationParent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destinationExists = await bucket.head(destination);
	if (!overwrite && destinationExists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destinationExists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handleDelete(
			new Request(new URL(destinationHeader), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	let isDir = isCollection(resource.customMetadata);

	if (isDir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resourcePath + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: preserveLocks(object.customMetadata),
						});
						await bucket.delete(object.key);
					}
				};
				let promiseArray = [move(resource)];
				for await (let object of listObjects(bucket, prefix, true)) {
					promiseArray.push(move(object));
				}
				await Promise.all(promiseArray);
				if (destinationExists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: preserveLocks(src.customMetadata),
		});
		await bucket.delete(resource.key);
		if (destinationExists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handleLock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return new Response('Bad Request', { status: 400 });
	}
	let { timeout, expiresAt } = parseLockTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// Per WebDAV, an empty LOCK request body indicates a lock refresh operation.
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	if (body !== '' && !/<write\b/i.test(body)) {
		return new Response('Bad Request', { status: 400 });
	}
	let owner = extractLockOwner(body);
	let lockResponse = await requireLockPermission(request, bucket, resourcePath, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resourcePath) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resourcePath));
	let currentLocks = getLocks(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
	if (
		refreshTarget === null &&
		body === '' &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return new Response('Locked', { status: 423 });
	}
	if (resource === null) {
		if (body === '') {
			return new Response('Bad Request', { status: 400 });
		}
		if (!(await hasCollectionResource(bucket, getParentPath(resourcePath)))) {
			return new Response('Conflict', { status: 409 });
		}
		if (request.url.endsWith('/')) {
			return new Response('Conflict', { status: 409 });
		}

		await bucket.put(resourcePath, new Uint8Array(), {
			customMetadata: {},
		});
		resource = await bucket.head(resourcePath);
		currentLocks = [];
	}

	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (existingLock === undefined) {
		if (requestedScope === 'exclusive' && currentLocks.length > 0) {
			return new Response('Locked', { status: 423 });
		}
		if (requestedScope === 'shared' && currentLocks.some((lockDetail) => lockDetail.scope === 'exclusive')) {
			return new Response('Locked', { status: 423 });
		}
	}
	let depth: (typeof VALID_LOCK_DEPTHS)[number];
	if (existingLock !== undefined && depthHeader === null && body === '') {
		// Refreshing an existing lock without an explicit Depth header:
		// preserve the original lock depth instead of broadening it.
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(
			resource.customMetadata?.resourcetype,
			depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
		);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, isCollection(resource.customMetadata)),
	};
	let updatedLocks =
		existingLock === undefined
			? [...currentLocks, lockDetails]
			: currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: writeLocks(resource.customMetadata, updatedLocks),
	});

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				...(existingLock
					? {}
					: {
							Location: getResourceHref(resource.key, isCollection(resource.customMetadata)),
						}),
			},
		},
	);
}

async function handleUnlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resourcePath = makeResourcePath(request);
	let resource = await bucket.head(resourcePath);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await requireLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = getLocks(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return new Response('Conflict', { status: 409 });
	}

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: writeLocks(
			resource.customMetadata,
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	});

	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

async function dispatchHandler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 200,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
		case 'HEAD': {
			return await handleHead(request, bucket);
		}
		case 'GET': {
			return await handleGet(request, bucket);
		}
		case 'PUT': {
			return await handlePut(request, bucket);
		}
		case 'DELETE': {
			return await handleDelete(request, bucket);
		}
		case 'MKCOL': {
			return await handleMkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handlePropfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handleProppatch(request, bucket);
		}
		case 'COPY': {
			return await handleCopy(request, bucket);
		}
		case 'MOVE': {
			return await handleMove(request, bucket);
		}
		case 'LOCK': {
			return await handleLock(request, bucket);
		}
		case 'UNLOCK': {
			return await handleUnlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

function isAuthorized(authorizationHeader: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorizationHeader);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return timingSafeEqual(header, expected);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (
			request.method !== 'OPTIONS' &&
			!isAuthorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		let response: Response = await dispatchHandler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'if',
				'lock-token',
				'timeout',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			[
				'content-type',
				'content-length',
				'dav',
				'etag',
				'last-modified',
				'location',
				'date',
				'content-range',
				'lock-token',
			].join(', '),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
