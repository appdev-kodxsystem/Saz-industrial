/**
 * A `fetch` that gives up instead of hanging forever.
 *
 * supabase-js sets no timeout on its requests. When the project is unreachable —
 * paused on the free tier, suspended, or simply behind a network that accepts
 * the TCP connection but never completes the TLS handshake — every call returns
 * a promise that never settles.
 *
 * That is worse than an error. `/_authenticated`'s beforeLoad awaits the org
 * lookup before it will render anything, so a stalled backend left the app
 * spinning indefinitely with nothing in the console and no way to tell a slow
 * network from a dead one.
 *
 * With a deadline the same situation surfaces as an error the error screen can
 * print, which is at least actionable.
 */
export const SUPABASE_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(timeoutMs = SUPABASE_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    // Honour a caller's own signal as well as the deadline — whichever aborts
    // first wins. supabase-js passes signals through for cancellable requests.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    try {
      return await fetch(input, { ...init, signal });
    } catch (err) {
      // A caller-initiated abort is not a fault — let it through untouched.
      if (init?.signal?.aborted) throw err;
      if (timeout.aborted) {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return "the server";
          }
        })();
        throw new Error(
          `Could not reach ${host} — no response within ${Math.round(timeoutMs / 1000)}s. ` +
            `If this is a Supabase project on the free plan it may have been paused for inactivity; ` +
            `open the Supabase dashboard and resume it. Otherwise check your network connection.`,
        );
      }
      throw err;
    }
  };
}
