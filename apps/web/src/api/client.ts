const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;

export type QueryParams = Record<string, string | number | undefined>;

export async function apiGet<T>(path: string, params: QueryParams = {}): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
