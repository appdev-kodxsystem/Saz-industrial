import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        {/* The actual reason, not just "something went wrong". beforeLoad throws
            messages written to be read (an unapplied migration, a lost session);
            swallowing them left a dead end with nothing to act on. */}
        {error?.message && (
          <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-left font-mono text-xs text-muted-foreground ring-1 ring-hairline">
            {error.message}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "SAZ Industrial" },
      {
        name: "description",
        content: "Card-based inventory: track stock, sales, and profits in one tidy place.",
      },
      { name: "author", content: "SAZ Industrial" },
      { property: "og:title", content: "SAZ Industrial" },
      {
        property: "og:description",
        content: "Card-based inventory: track stock, sales, and profits in one tidy place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "SAZ Industrial" },
      {
        name: "twitter:description",
        content: "Card-based inventory: track stock, sales, and profits in one tidy place.",
      },
      { property: "og:image", content: "/logo.png" },
      { name: "twitter:image", content: "/logo.png" },
    ],
    links: [
      {
        rel: "preload",
        as: "image",
        href: "/logo.webp",
        fetchPriority: "high",
      },
      {
        rel: "icon",
        type: "image/png",
        href: "/favicon-48.png",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Instant paint: the whole app is client-rendered (ssr:false), so this
            splash is the first contentful paint and the LCP element. RootComponent
            removes it once the router goes idle — not on mount, or it uncovers a
            blank page while the first route is still loading. Inline styles only
            — no CSS dependency. */}
        <div
          id="app-splash"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#ffffff",
            transition: "opacity .3s ease",
          }}
        >
          <div
            style={{
              width: "40px",
              height: "40px",
              border: "3px solid #f0f0f3",
              borderTopColor: "#111827",
              borderRadius: "50%",
              animation: "appspin .6s cubic-bezier(.5,.15,.5,.85) infinite",
            }}
          />
          <style>{"@keyframes appspin{to{transform:rotate(360deg)}}"}</style>
        </div>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // Drop the instant-paint splash once the router has actually settled — NOT
  // merely once React has mounted.
  //
  // React mounts well before /_authenticated's beforeLoad resolves (a session
  // check plus a getMyOrg() server call). Removing the splash on mount tore it
  // away mid-load and left a blank background until the route was ready, which
  // on a slow connection looked exactly like the app failing to render.
  const routerStatus = useRouterState({ select: (s) => s.status });

  useEffect(() => {
    if (routerStatus !== "idle") return;
    const el = document.getElementById("app-splash");
    if (!el) return;
    el.style.opacity = "0";
    const t = setTimeout(() => el.remove(), 300);
    return () => clearTimeout(t);
  }, [routerStatus]);

  useEffect(() => {
    let mounted = true;
    import("@/integrations/supabase/client").then(({ supabase }) => {
      if (!mounted) return;
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
        router.invalidate();
        if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
      });
      return () => sub.subscription.unsubscribe();
    });
    return () => {
      mounted = false;
    };
  }, [router, queryClient]);

  useEffect(() => {
    const handleWheel = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target?.tagName === "INPUT" && target?.type === "number") {
        e.preventDefault();
      }
    };

    document.addEventListener("wheel", handleWheel, { passive: false } as EventListenerOptions);
    return () =>
      document.removeEventListener("wheel", handleWheel, { passive: false } as EventListenerOptions);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
