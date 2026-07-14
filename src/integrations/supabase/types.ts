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
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
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
          user_id: string
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
          user_id: string
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
          user_id?: string
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
    }
    Views: {
      [_ in never]: never
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
          created_at: string
        }[]
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
        Returns: undefined
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
