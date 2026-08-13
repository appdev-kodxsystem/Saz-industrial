import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'
import { fetchWithTimeout } from './fetch-timeout';

type SupabaseClient = ReturnType<typeof createClient<Database>>

/**
 * Per-token cache of the request-scoped Supabase client and its verified claims.
 *
 * Both halves used to be rebuilt on every single server function call, and that
 * was the dominant cost of every request:
 *
 *   - `createClient` starts with a cold JWKS cache, so the very first
 *     `getClaims()` on a fresh instance goes to the network to fetch the signing
 *     keys. One instance per request meant one JWKS fetch per request.
 *   - `getClaims()` then verifies the JWT. Re-verifying the same token on every
 *     call in a burst (a page load fires several server functions at once) is
 *     pure repeat work.
 *
 * Caching by the token string is safe: the token IS the credential, so two
 * requests that share a cache entry are by definition the same authenticated
 * caller. A token that fails verification is never cached, and entries expire at
 * the token's own `exp` — so a cached entry can never outlive the JWT it came
 * from, and revocation-by-expiry still works exactly as before.
 */
type CacheEntry = {
  supabase: SupabaseClient
  claims: Record<string, unknown> & { sub: string }
  /** ms epoch; min(token exp, now + MAX_TTL_MS) */
  expiresAt: number
}

const tokenCache = new Map<string, CacheEntry>()

/** Never trust a cached verification for longer than this, even for a long-lived JWT. */
const MAX_TTL_MS = 60_000
/** Bound memory on a long-lived server; entries are small but unbounded growth is not ok. */
const MAX_ENTRIES = 500

function pruneCache(now: number) {
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key)
  }
  // Still oversized after dropping expired entries: evict oldest-inserted first
  // (Map preserves insertion order).
  while (tokenCache.size > MAX_ENTRIES) {
    const oldest = tokenCache.keys().next()
    if (oldest.done) break
    tokenCache.delete(oldest.value)
  }
}

export const requireSupabaseAuth = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      const missing = [
        ...(!SUPABASE_URL ? ['VITE_SUPABASE_URL'] : []),
        ...(!SUPABASE_PUBLISHABLE_KEY ? ['VITE_SUPABASE_PUBLISHABLE_KEY'] : []),
      ];
      const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in .env.`;
      console.error(`[Supabase] ${message}`);
      throw new Error(message);
    }

    const request = getRequest();

    if (!request?.headers) {
      throw new Error('Unauthorized: No request headers available');
    }

    const authHeader = request.headers.get('authorization');

    if (!authHeader) {
      throw new Error('Unauthorized: No authorization header provided');
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized: Only Bearer tokens are supported');
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized: No token provided');
    }

    const now = Date.now();
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > now) {
      return next({
        context: {
          supabase: cached.supabase,
          userId: cached.claims.sub,
          claims: cached.claims,
        },
      });
    }

    const supabase = createClient<Database>(
      SUPABASE_URL!,
      SUPABASE_PUBLISHABLE_KEY!,
      {
        global: {
          fetch: fetchWithTimeout(),
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        auth: {
          storage: undefined,
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims) {
      tokenCache.delete(token);
      throw new Error('Unauthorized: Invalid token');
    }

    if (!data.claims.sub) {
      tokenCache.delete(token);
      throw new Error('Unauthorized: No user ID found in token');
    }

    const claims = data.claims as CacheEntry['claims'];

    // `exp` is seconds since epoch. Missing/!finite exp -> fall back to MAX_TTL_MS
    // rather than caching forever.
    const expSeconds = typeof claims.exp === 'number' ? claims.exp : undefined;
    const tokenExpiresAt = expSeconds && Number.isFinite(expSeconds) ? expSeconds * 1000 : Infinity;
    const expiresAt = Math.min(tokenExpiresAt, now + MAX_TTL_MS);

    if (expiresAt > now) {
      tokenCache.set(token, { supabase, claims, expiresAt });
      pruneCache(now);
    }

    return next({
      context: {
        supabase,
        userId: claims.sub,
        claims,
      },
    });
  },
);
