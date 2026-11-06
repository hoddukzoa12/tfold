import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export type FixtureServer = { baseURL: string; close(): Promise<void> };

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.join(import.meta.dirname, 'fixtures');

const vendored: Record<string, string> = {
	'/vendor/react.js': 'node_modules/react/umd/react.development.js',
	'/vendor/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
};

const contentTypes: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
};

async function isFile(file: string): Promise<boolean> {
	return (await stat(file).catch(() => null))?.isFile() ?? false;
}

async function resolveFile(urlPath: string): Promise<string | null> {
	const vendor = vendored[urlPath];
	if (vendor) return path.join(repoRoot, vendor);
	const file = path.join(fixturesDir, urlPath);
	if (!file.startsWith(fixturesDir + path.sep)) return null;
	const appIndex = path.join(fixturesDir, urlPath.split('/')[1] ?? '', 'index.html');
	const candidates = [file, path.join(file, 'index.html'), ...(path.extname(urlPath) ? [] : [appIndex])];
	for (const candidate of candidates) if (await isFile(candidate)) return candidate;
	return null;
}

async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	const urlPath = decodeURIComponent(new URL(request.url ?? '/', 'http://fixture').pathname);
	if (urlPath === '/favicon.ico') {
		response.writeHead(204).end();
		return;
	}
	const file = await resolveFile(urlPath);
	if (!file) {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, {
		'content-type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
		'cache-control': 'no-store',
	});
	createReadStream(file).pipe(response);
}

export async function startFixtureServer(): Promise<FixtureServer> {
	const server = http.createServer((request, response) => void serve(request, response));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseURL: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
