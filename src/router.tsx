import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteFallback } from "./components/inventory/RouteFallback";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // React Query's default staleTime is 0, which means every query refetches
        // the moment a component remounts. In an app where the same data is shown
        // on several pages, that turned every navigation into a fresh round trip
        // even when the data was seconds old. 30s keeps things current without
        // re-fetching on every tab switch.
        //
        // The pages that genuinely want live data (ledger, pending payments,
        // reports) set their own refetchInterval and override this locally.
        staleTime: 30_000,
        // Keep unmounted data around long enough that going away and coming back
        // renders instantly from cache while any refetch happens in the
        // background.
        gcTime: 5 * 60_000,
        // Refocusing the window re-fired every mounted query at once. With a
        // staleTime the refetch is usually pointless, and it made alt-tabbing
        // back into the app feel like a reload.
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        // Three retries with exponential backoff means a genuinely failing
        // request hangs the UI for ~7s before it will admit the error.
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Start loading a route as soon as the pointer lands on its link, so the
    // data is usually already there by the time the click registers.
    defaultPreload: "intent",
    // Was 0, which re-ran every preload from scratch and defeated the point of
    // preloading. Matches the query staleTime above.
    defaultPreloadStaleTime: 30_000,

    // Without a pending component a route that is still resolving renders
    // NOTHING — and /_authenticated resolves a session check plus a getMyOrg()
    // server call before it will render anything at all. That showed as a blank
    // page with a clean console, which reads as "the app is broken".
    defaultPendingComponent: RouteFallback,
    // Show it quickly, but hold it briefly once shown so a fast load doesn't
    // flash a spinner for one frame.
    defaultPendingMs: 150,
    defaultPendingMinMs: 300,
  });

  return router;
};
