import { z } from 'zod';

const errorSchema = z.object({ detail: z.string() });

export function errorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  return error instanceof Error ? error.message : fallback;
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = window.setTimeout(cancel, 15_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = errorSchema.safeParse(payload);
      throw new Error(
        response.status === 429
          ? 'Too many sign-in attempts. Wait a minute and try again.'
          : error.success
            ? error.data.detail
            : 'The server is unavailable. Please try again.',
      );
    }
    const result = schema.safeParse(payload);
    if (!result.success)
      throw new Error('The server sent an invalid response. Please refresh and try again.');
    return result.data;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error('The server took too long to respond. Please try again.', { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
