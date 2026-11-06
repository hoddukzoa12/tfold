import type { Language } from '../i18n.ts';
import type { ProviderId } from './providers/presets.ts';
import type { Fold } from './types.ts';

export type CacheKey = string & { readonly __brand: 'CacheKey' };
export type CacheKeyParts = {
	url: string;
	sentences: string[];
	provider: ProviderId;
	baseUrl: string;
	model: string;
	promptVersion: number;
	translateTo: Language | undefined;
};

const storeName = 'folds';
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
	database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open('tfold', 1);
		request.onupgradeneeded = () => request.result.createObjectStore(storeName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
	});
	return database;
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	return new Promise((resolve, reject) => {
		const request = act(db.transaction(storeName, mode).objectStore(storeName));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

export async function cacheKey({ url, sentences, provider, baseUrl, model, promptVersion, translateTo }: CacheKeyParts): Promise<CacheKey> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sentences)));
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return JSON.stringify([promptVersion, provider, baseUrl, model, url, translateTo ?? null, hash]) as CacheKey;
}

export function readCache(key: CacheKey): Promise<Fold | undefined> {
	return run('readonly', (store) => store.get(key) as IDBRequest<Fold | undefined>);
}

export async function writeCache(key: CacheKey, fold: Fold): Promise<void> {
	await run('readwrite', (store) => store.put(fold, key));
}
