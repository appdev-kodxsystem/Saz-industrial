export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string
          name: string
          owner_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          owner_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          owner_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      organization_members: {
        Row: {
          id: string
          org_id: string
          user_id: string | null
          email: string
          role: string
          status: string
          password_set: boolean
          invited_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id?: string | null
          email: string
          role?: string
          status?: string
          invited_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          user_id?: string | null
          email?: string
          role?: string
          status?: string
          invited_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          name: string
          org_id: string
          pinned: boolean
          purchase_price: number
          reorder_at: number
          selling_price: number
          sku: string
          stock: number
          updated_at: string
          // Audit stamp only — goes NULL if the member who created it is
          // removed. org_id is the tenant key.
          user_id: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name: string
          org_id: string
          pinned?: boolean
          purchase_price?: number
          reorder_at?: number
          selling_price?: number
          sku: string
          stock?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name?: string
          org_id?: string
          pinned?: boolean
          purchase_price?: number
          reorder_at?: number
          selling_price?: number
          sku?: string
          stock?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          company: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          company?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      stock_items: {
        Row: {
          id: string
          product_id: string | null
          org_id: string
          user_id: string | null
          // The stock order this unit arrived on. NULL for units added before
          // ordering existed, or if the order row was later deleted.
          order_id: string | null
          product_name: string | null
          product_sku: string | null
          product_image_url: string | null
          manufacture_id: string
          purchase_price: number
          sold: boolean
          created_at: string
          sold_at: string | null
        }
        Insert: {
          id?: string
          product_id?: string | null
          org_id: string
          user_id?: string | null
          order_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          product_image_url?: string | null
          manufacture_id: string
          purchase_price?: number
          sold?: boolean
          created_at?: string
          sold_at?: string | null
        }
        Update: {
          id?: string
          product_id?: string | null
          org_id?: string
          user_id?: string | null
          order_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          product_image_url?: string | null
          manufacture_id?: string
          purchase_price?: number
          sold?: boolean
          created_at?: string
          sold_at?: string | null
        }
        Relationships: []
      }
      stock_orders: {
        Row: {
          id: string
          org_id: string
          user_id: string | null
          supplier: string | null
          note: string | null
          // Storage path inside the private `receipts` bucket — sign it to read.
          receipt_path: string | null
          // Machinery only. Add-on spend on the same order is kept apart in
          // addon_cost / addon_unit_count so "what did we spend on machinery"
          // stays answerable.
          total_cost: number
          unit_count: number
          addon_cost: number
          addon_unit_count: number
          created_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id?: string | null
          supplier?: string | null
          note?: string | null
          receipt_path?: string | null
          total_cost?: number
          unit_count?: number
          addon_cost?: number
          addon_unit_count?: number
          created_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          user_id?: string | null
          supplier?: string | null
          note?: string | null
          receipt_path?: string | null
          total_cost?: number
          unit_count?: number
          addon_cost?: number
          addon_unit_count?: number
          created_at?: string
        }
        Relationships: []
      }
      sales: {
        Row: {
          id: string
          product_id: string | null
          stock_item_id: string | null
          org_id: string
          user_id: string | null
          product_name: string | null
          product_sku: string | null
          product_image_url: string | null
          selling_price: number
          net_payment: number
          pending_payment: number
          payment_status: string
          customer_name: string | null
          customer_contact: string | null
          created_at: string
        }
        Insert: {
          id?: string
          product_id?: string | null
          stock_item_id?: string | null
          org_id: string
          user_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          product_image_url?: string | null
          selling_price: number
          net_payment?: number
          payment_status?: string
          customer_name?: string | null
          customer_contact?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          product_id?: string | null
          stock_item_id?: string | null
          org_id?: string
          user_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          product_image_url?: string | null
          selling_price?: number
          net_payment?: number
          payment_status?: string
          customer_name?: string | null
          customer_contact?: string | null
          created_at?: string
        }
        Relationships: []
      }
      // --- Add-ons: free extras handed out with a sold unit -----------------
      // Their own tables entirely. Nothing about add-ons is bolted onto
      // products, stock_items or sales.
      addons: {
        Row: {
          id: string
          org_id: string
          user_id: string | null
          name: string
          // SKU, unique per org (case-insensitively). Batch codes derive from it.
          code: string
          category: string
          description: string | null
          image_url: string | null
          // What one costs the org. Seeds the stock-in form; what actually hits
          // profit is the unit_cost of the batch a unit came out of.
          unit_cost: number
          // What it's worth to the CUSTOMER, for the receipt line. Display only.
          list_value: number
          reorder_at: number
          // Retired add-ons stay on old sales but leave the sell-time picker.
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          org_id: string
          user_id?: string | null
          name: string
          code: string
          category?: string
          description?: string | null
          image_url?: string | null
          unit_cost?: number
          list_value?: number
          reorder_at?: number
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          org_id?: string
          user_id?: string | null
          name?: string
          code?: string
          category?: string
          description?: string | null
          image_url?: string | null
          unit_cost?: number
          list_value?: number
          reorder_at?: number
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      addon_stock_batches: {
        Row: {
          id: string
          addon_id: string | null
          org_id: string
          user_id: string | null
          // The supplier run this lot arrived on — shared with machinery
          // stock-in, so one receipt can cover both.
          order_id: string | null
          addon_name: string | null
          addon_code: string | null
          batch_code: string
          // What arrived (never changes) vs what is still on the shelf.
          quantity: number
          remaining: number
          unit_cost: number
          created_at: string
        }
        Insert: {
          id?: string
          addon_id?: string | null
          org_id: string
          user_id?: string | null
          order_id?: string | null
          addon_name?: string | null
          addon_code?: string | null
          // Optional on insert: the addon_batch_defaults BEFORE INSERT trigger
          // issues it (TK-01-B0001, …) after locking the catalogue row.
          batch_code?: string
          quantity: number
          remaining?: number
          unit_cost?: number
          created_at?: string
        }
        Update: {
          id?: string
          addon_id?: string | null
          org_id?: string
          user_id?: string | null
          order_id?: string | null
          addon_name?: string | null
          addon_code?: string | null
          batch_code?: string
          quantity?: number
          remaining?: number
          unit_cost?: number
          created_at?: string
        }
        Relationships: []
      }
      sale_addons: {
        Row: {
          id: string
          // NOT NULL by design: an add-on cannot exist without the sale it went
          // out on. `authenticated` also has no INSERT grant here — the only
          // door in is the addon_attach_to_sale() RPC.
          sale_id: string
          addon_id: string | null
          batch_id: string | null
          org_id: string
          user_id: string | null
          addon_name: string | null
          addon_code: string | null
          addon_image_url: string | null
          quantity: number
          // Frozen at attach time, so a later price correction never rewrites
          // the profit of a sale that already happened.
          unit_cost: number
          // Generated column: unit_cost * quantity. This is what comes off profit.
          total_cost: number
          list_value: number
          created_at: string
        }
        Insert: {
          id?: string
          sale_id: string
          addon_id?: string | null
          batch_id?: string | null
          org_id: string
          user_id?: string | null
          addon_name?: string | null
          addon_code?: string | null
          addon_image_url?: string | null
          quantity: number
          unit_cost?: number
          list_value?: number
          created_at?: string
        }
        Update: {
          id?: string
          sale_id?: string
          addon_id?: string | null
          batch_id?: string | null
          org_id?: string
          user_id?: string | null
          addon_name?: string | null
          addon_code?: string | null
          addon_image_url?: string | null
          quantity?: number
          unit_cost?: number
          list_value?: number
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      // On-hand per add-on, derived from the batches rather than kept as a
      // counter — so it cannot drift out of step with reality.
      addon_stock_levels: {
        Row: {
          addon_id: string
          org_id: string
          on_hand: number
          received: number
          given_away: number
          on_hand_value: number
          total_spend: number
        }
        Relationships: []
      }
      // One row per sale that carried add-ons. Join this in wherever profit is
      // shown: profit = selling_price - unit cost - addon_cost.
      sale_addon_totals: {
        Row: {
          sale_id: string
          org_id: string
          addon_units: number
          addon_cost: number
          addon_list_value: number
        }
        Relationships: []
      }
    }
    Functions: {
      email_exists: {
        Args: { p_email: string }
        Returns: boolean
      }
      current_org_id: {
        Args: Record<string, never>
        Returns: string | null
      }
      current_org_role: {
        Args: Record<string, never>
        Returns: string | null
      }
      is_org_admin: {
        Args: Record<string, never>
        Returns: boolean
      }
      apply_stock_delta: {
        Args: { p_product_id: string; p_delta: number }
        Returns: number
      }
      // The only door into add-on stock. SECURITY DEFINER: it re-derives the org
      // from the caller's JWT and refuses to run unless the sale already exists
      // in it — which is what makes "no add-on without an item" true in the
      // database rather than only in the UI. Returns what the giveaway cost.
      addon_attach_to_sale: {
        Args: { p_sale_id: string; p_addon_id: string; p_qty: number }
        Returns: number
      }
      // The whole cart in one transaction: every add-on lands, or none do.
      // p_lines: [{ sale_id, addon_id, qty }, …]
      addon_attach_bulk: {
        Args: { p_lines: Json }
        Returns: number
      }
      org_list_members: {
        Args: Record<string, never>
        Returns: {
          id: string
          user_id: string | null
          email: string
          role: string
          status: string
          display_name: string | null
          avatar_url: string | null
          password_set: boolean
          is_owner: boolean
          created_at: string
        }[]
      }
      org_rename: {
        Args: { p_name: string }
        Returns: undefined
      }
      org_mark_password_set: {
        Args: Record<string, never>
        Returns: undefined
      }
      org_invite_member: {
        Args: { p_email: string; p_role: string }
        Returns: string
      }
      org_discard_invite: {
        Args: { p_member_id: string }
        Returns: undefined
      }
      org_update_member_role: {
        Args: { p_member_id: string; p_role: string }
        Returns: undefined
      }
      org_remove_member: {
        Args: { p_member_id: string }
        // The removed member's auth user id, so the caller can delete the
        // account. NULL for a never-claimed invite.
        Returns: string | null
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
