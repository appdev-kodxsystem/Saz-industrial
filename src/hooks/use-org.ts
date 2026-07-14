import { useRouteContext } from "@tanstack/react-router";

/**
 * The caller's organization and role, resolved once in the /_authenticated
 * beforeLoad and read from router context here — no extra request per component.
 *
 * `isAdmin` is the flag every write-surface gates on. It hides buttons; it is
 * NOT the security boundary. The real enforcement is requireOrgAdmin on the
 * server functions and the org policies in the database. Treat this as UI only.
 */
export function useOrg() {
  return useRouteContext({ from: "/_authenticated" });
}
