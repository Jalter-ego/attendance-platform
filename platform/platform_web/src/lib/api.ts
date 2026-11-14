export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `${import.meta.env.VITE_API_URL || '/api/v1'}${path}`,
      {
        ...options,
        credentials: 'include',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new Error(
      'No se pudo conectar con la plataforma. Intenta de nuevo en un momento.',
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 && path !== '/auth/login')
      window.dispatchEvent(new Event('platform:unauthenticated'));
    const field = body?.error?.fields?.[0];
    throw new ApiError(
      response.status,
      field
        ? `${field.path}: ${field.message}`
        : body?.error?.message || 'No se pudo completar la solicitud.',
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
