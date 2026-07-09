import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "SAZ Industrial — Modern inventory for solo operators" },
      {
        name: "description",
        content: "Card-based inventory: track stock, sales, and profits in one tidy place.",
      },
      { property: "og:title", content: "SAZ Industrial — Modern inventory for solo operators" },
      {
        property: "og:description",
        content: "Card-based inventory: track stock, sales, and profits in one tidy place.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      navigate({ to: data.session ? "/inventory" : "/auth", replace: true });
    });
  }, [navigate]);

  return <div className="grid min-h-screen place-items-center bg-background" />;
}
