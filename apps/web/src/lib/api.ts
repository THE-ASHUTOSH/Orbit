/** Thin REST helpers. Cookies do the authentication; nothing is stored in JS. */
export interface SelfUser {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user' | 'viewer';
  lastTabId: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<{ user: SelfUser }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: SelfUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  restartBrowser: () => request<{ ok: boolean }>('/api/admin/browser/restart', { method: 'POST' }),
  users: () => request<{ users: (SelfUser & { createdAt: number; lastSeenAt: number | null })[] }>('/api/admin/users'),
  createUser: (body: { username: string; password: string; role: string; displayName?: string }) =>
    request<{ user: SelfUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  deleteUser: (userId: string) => request<{ ok: boolean }>(`/api/admin/users/${userId}`, { method: 'DELETE' }),
  disconnectUser: (userId: string) =>
    request<{ ok: boolean; closed: number }>(`/api/admin/users/${userId}/disconnect`, { method: 'POST' }),
  cookies: () => request<{ domains: { domain: string; count: number; sessionCookies: number }[] }>('/api/admin/cookies'),
  audit: () =>
    request<{ events: { id: string; at: number; user_id: string | null; action: string; detail: string | null }[] }>(
      '/api/admin/audit?limit=50',
    ),
  downloads: () => request<{ files: { name: string; size: number; modified: number }[] }>('/api/downloads'),
  uploads: () => request<{ files: { name: string; size: number }[] }>('/api/uploads'),
  upload: async (file: File) => {
    const res = await fetch(`/api/uploads/${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    });
    if (!res.ok) throw new ApiError(res.status, 'upload_failed');
    return (await res.json()) as { name: string; size: number };
  },
  devtoolsUrl: (tabId: string) => request<{ url: string; targetId: string }>(`/api/tabs/${tabId}/devtools`),
  deleteDownload: (name: string) =>
    request<{ ok: boolean }>(`/api/downloads/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  extensions: () =>
    request<{
      extensions: { id: string; name: string; version: string; manifestVersion: number; permissions: string[]; sizeBytes: number }[];
      restartRequiredToApply: boolean;
    }>('/api/admin/extensions'),
  installExtension: async (file: File) => {
    const res = await fetch(`/api/admin/extensions/${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    if (!res.ok) throw new ApiError(res.status, body.detail || body.error || 'install_failed');
    return body;
  },
  removeExtension: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/extensions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  grant: (tabId: string, userId: string, permission: string) =>
    request<{ ok: boolean }>(`/api/tabs/${tabId}/grants/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ permission }),
    }),
  revoke: (tabId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/tabs/${tabId}/grants/${userId}`, { method: 'DELETE' }),
};
