import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAddons } from "@/lib/addons.functions";
import { AddonForm } from "@/components/addons/AddonForm";
import { PageHeader, PageBody } from "@/components/inventory/AppShell";

export const Route = createFileRoute("/_authenticated/addons/$addonId/edit")({
  head: () => ({ meta: [{ title: "Edit Add-on — SAZ Industrial" }] }),
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/addons" });
  },
  component: EditAddonPage,
});

function EditAddonPage() {
  const { addonId } = Route.useParams();
  const navigate = useNavigate();
  const list = useServerFn(listAddons);
  const { data: addons = [], isLoading } = useQuery({
    queryKey: ["addons"],
    queryFn: () => list(),
  });

  const addon = addons.find((a) => a.id === addonId) ?? null;
  const categories = useMemo(
    () => Array.from(new Set(addons.map((a) => a.category).filter(Boolean))).sort(),
    [addons],
  );

  if (isLoading) {
    return (
      <>
        <PageHeader title="Edit add-on" />
        <PageBody>
          <div className="h-64 animate-pulse rounded-2xl bg-surface" />
        </PageBody>
      </>
    );
  }

  if (!addon) {
    return (
      <>
        <PageHeader title="Add-on not found" />
        <PageBody className="text-center">
          <p className="text-sm text-muted-foreground">
            That add-on no longer exists, or it belongs to another organization.
          </p>
          <button
            onClick={() => navigate({ to: "/addons" })}
            className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
          >
            Back to add-ons
          </button>
        </PageBody>
      </>
    );
  }

  // Keyed so switching between add-ons remounts the form with fresh state
  // instead of showing the previous one's edits.
  return <AddonForm key={addon.id} initial={addon} categories={categories} />;
}
