export async function authenticatedBackendFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const getToken = window.electronAPI?.getDeveloperBackendAuthToken;
  if (!getToken) {
    throw new Error('Authenticated backend settings are available only through the trusted desktop application.');
  }
  const token = await getToken();
  if (!token) throw new Error('Backend authentication is unavailable.');
  const headers = new Headers(init.headers);
  headers.set('X-Coding-Auth', token);
  return fetch(input, { ...init, headers });
}
