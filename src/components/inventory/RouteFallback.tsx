"use client";

import { useEffect, useState } from "react";

/**
 * What the screen shows while a route is loading.
 *
 * Without this the app rendered *nothing* between React mounting and a route's
 * beforeLoad resolving. On /_authenticated that gap contains a session check
 * plus a getMyOrg() server call, so on a slow connection it was seconds of
 * blank background with no spinner and nothing in the console — indistinguishable
 * from the app being broken.
 *
 * After SLOW_MS it stops pretending the wait is normal and offers a way out,
 * because a stalled load previously had no recovery short of guessing.
 */
const SLOW_MS = 8000;

export function RouteFallback() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center"
    >
      <span className="size-10 animate-spin rounded-full border-[3px] border-hairline border-t-foreground" />
      <span className="sr-only">Loading</span>

      {slow && (
        <div className="flex max-w-xs flex-col items-center gap-3 animate-in fade-in duration-300">
          <p className="text-sm text-muted-foreground">
            This is taking longer than usual. Your connection may have dropped.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Reload
          </button>
        </div>
      )}
    </div>
  );
}

export default RouteFallback;
