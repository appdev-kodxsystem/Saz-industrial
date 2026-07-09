import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface ProfileRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  company: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("*")
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as unknown as ProfileRow | null;
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        display_name: z.string().max(120).nullable().optional(),
        avatar_url: z.string().url().max(500).nullable().optional(),
        company: z.string().max(120).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const payload = { id: context.userId, ...data };
    const { data: row, error } = await context.supabase
      .from("profiles")
      .upsert(payload)
      .eq("id", context.userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as ProfileRow;
  });
