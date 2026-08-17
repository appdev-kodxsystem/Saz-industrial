import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAddons } from "@/lib/addons.functions";
import { AddonForm } from "@/components/addons/AddonForm";

export const Route = createFileRoute("/_authenticated/addons/new")({
  head: () => ({ meta: [{ title: "Add Add-on — SAZ Industrial" }] }),
  // Admin-only, same rule as every other catalogue write surface. Hiding the
  // button is not enough — an employee can type the URL.
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/addons" });
  },
  component: NewAddonPage,
});

function NewAddonPage() {
  const list = useServerFn(listAddons);
  // Only for the category suggestions. Shares the cache with the Add-ons page,
  // so arriving from there costs nothing.
  const { data: addons = [] } = useQuery({ queryKey: ["addons"], queryFn: () => list() });
  const categories = useMemo(
    () => Array.from(new Set(addons.map((a) => a.category).filter(Boolean))).sort(),
    [addons],
  );

  return <AddonForm initial={null} categories={categories} />;
}
