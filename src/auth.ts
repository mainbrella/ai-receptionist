export const API_ORIGIN = window.location.origin;

type Session = { user: { id: string } } | null;

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${API_ORIGIN}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...options,
    });
  } catch {
    throw new Error('Could not reach Voice. Check your connection and try again.');
  }
}

export function createAuthClient() {
  return {
    async readSession(): Promise<Session> {
      const response = await request('/auth/session');
      const data = await response.json().catch(() => null);
      if (response.status === 401) return null;
      if (!response.ok || !data || typeof data !== 'object' || !('user' in data)) {
        throw new Error('Could not check your sign-in. Please try again.');
      }
      return data.user && typeof data.user.id === 'string' ? { user: { id: data.user.id } } : null;
    },
    async signIn(password: string): Promise<void> {
      const response = await request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      if (response.ok) return;
      const data = await response.json().catch(() => null);
      if (response.status === 429) throw new Error('Too many attempts. Wait a moment and try again.');
      if (response.status === 401 || data?.error === 'invalid_password') throw new Error('That password is incorrect. Try again.');
      throw new Error('Could not sign you in. Please try again.');
    },
    async signOut(): Promise<void> {
      const response = await request('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign you out. Please try again.');
    },
  };
}
