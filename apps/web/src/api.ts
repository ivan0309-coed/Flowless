export type User = { id: string; email: string; name: string; isAdmin: boolean; scopes?: string[] };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" })) as { error?: string };
    throw new Error(body.error ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}
