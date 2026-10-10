import { runtimeConfig } from './runtimeConfig.ts';

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

export function isBrowserDevelopment(): boolean {
  if (!import.meta.env?.DEV || typeof window === 'undefined' || window.electronAPI) return false;
  return window.location.protocol === 'http:' && isLoopback(window.location.hostname);
}

function isConfiguredLocalBackend(input: RequestInfo | URL): boolean {
  if (!isBrowserDevelopment()) return false;
  const configuredBackend = new URL(runtimeConfig.httpUrl);
  const requestAddress = input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.href
      : input;
  const requestUrl = new URL(requestAddress, window.location.href);
  return configuredBackend.protocol === 'http:'
    && isLoopback(configuredBackend.hostname)
    && requestUrl.origin === configuredBackend.origin;
}

export async function authenticatedBackendFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const getToken = window.electronAPI?.getDeveloperBackendAuthToken;
  if (!getToken) {
    if (!isConfiguredLocalBackend(input)) {
      throw new Error('Authenticated backend settings are available only through the trusted desktop application or its local development preview.');
    }
    const headers = new Headers(init.headers);
    headers.set('X-Coding-Browser-Access', 'development');
    return fetch(input, { ...init, headers });
  }
  const token = await getToken();
  if (!token) throw new Error('Backend authentication is unavailable.');
  const headers = new Headers(init.headers);
  headers.set('X-Coding-Auth', token);
  return fetch(input, { ...init, headers });
}
