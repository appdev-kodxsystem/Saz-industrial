"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Boxes,
  Building2,
  Gift,
  Menu,
  PackagePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PlusCircle,
  ShoppingCart,
  Truck,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { UserMenu } from "@/components/inventory/UserMenu";
import { CartButton } from "@/components/cart/CartButton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useOrg } from "@/hooks/use-org";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Admin-only destination. Employees never see the link, and the route itself
   *  redirects them away — see the beforeLoad guards on those routes. */
  adminOnly?: boolean;
  /** Match the active state on the exact path only. Used for the two "create"
   *  destinations, which live under a section that has its own list page. */
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
}

// Grouped destinations, shared by the desktop sidebar and the mobile drawer.
//
// Employees get Operations only. Records and Admin both expose purchase cost
// and therefore profit margin, so they are admin-only.
const GROUPS: NavGroup[] = [
  {
    label: "Operations",
    // Sales and Purchases sit next to each other on purpose: they are the two
    // sides of the same ledger (money out, money in) and get compared against
    // each other constantly. Purchases used to live two groups away, under
    // Stock, which made that comparison a hunt.
    items: [
      { to: "/inventory", label: "Inventory", icon: Boxes },
      // Add-ons sit next to Inventory because they are the other half of what
      // goes out of the door — and employees need to see what they can promise
      // at the counter, so this is not admin-only.
      { to: "/addons", label: "Add-ons", icon: Gift, exact: true },
      { to: "/sales", label: "Sales", icon: ShoppingCart },
      { to: "/purchases", label: "Purchases", icon: Truck, adminOnly: true },
      { to: "/pending-payments", label: "Pending Payments", icon: Wallet },
    ],
  },
  {
    label: "Create",
    adminOnly: true,
    items: [
      { to: "/products/new", label: "Add Product", icon: PlusCircle, adminOnly: true, exact: true },
      { to: "/addons/new", label: "Add Add-on", icon: Gift, adminOnly: true, exact: true },
      { to: "/stock/new", label: "Add Stock", icon: PackagePlus, adminOnly: true, exact: true },
    ],
  },
  {
    label: "Admin",
    adminOnly: true,
    items: [
      { to: "/reports", label: "Reports", icon: BarChart3, adminOnly: true },
      { to: "/organization", label: "Organization", icon: Building2, adminOnly: true },
    ],
  },
];

const COLLAPSE_KEY = "saz_sidebar_collapsed";

function isActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * Persistent app chrome: a fixed left sidebar on desktop (collapsible to an icon
 * rail) and a slim top bar + navigation drawer on mobile. Rendered ONCE in the
 * authenticated layout so it survives navigation. Page-specific controls live in
 * <PageHeader>, not here.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const { isAdmin } = useOrg();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Read the persisted rail state after mount. The authenticated layout is
  // client-only (ssr: false), but guarding keeps this safe if that ever changes.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  const groups = GROUPS.filter((g) => isAdmin || !g.adminOnly).map((g) => ({
    ...g,
    items: g.items.filter((i) => isAdmin || !i.adminOnly),
  }));

  // The content column is offset by exactly the sidebar's width. Driving both
  // from one custom property keeps them in step through the collapse animation
  // instead of the main area jumping a frame ahead of the rail.
  const width = collapsed ? "76px" : "264px";

  return (
    <TooltipProvider delayDuration={0}>
      <div style={{ ["--sidebar-w" as string]: width }} className="min-h-dvh">
        {/* desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-w)] flex-col border-r border-hairline bg-surface transition-[width] duration-300 ease-out lg:flex">
          <div
            className={`flex h-16 shrink-0 items-center border-b border-hairline ${
              collapsed ? "justify-center px-2" : "justify-between px-4"
            }`}
          >
            <Link to="/inventory" className="flex min-w-0 items-center gap-2.5">
              <img
                src="/logo.webp"
                alt="SAZ Industrial"
                width={36}
                height={36}
                className="size-9 shrink-0 rounded-lg object-contain"
              />
              {!collapsed && (
                <span className="truncate text-sm font-semibold tracking-tight">
                  SAZ Industrial
                </span>
              )}
            </Link>
            {!collapsed && (
              <button
                onClick={toggleCollapsed}
                aria-label="Collapse sidebar"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <PanelLeftClose className="size-4" />
              </button>
            )}
          </div>

          <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
            {collapsed && (
              <button
                onClick={toggleCollapsed}
                aria-label="Expand sidebar"
                className="grid w-full place-items-center rounded-xl py-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                <PanelLeftOpen className="size-4" />
              </button>
            )}
            {groups.map((group) => (
              <div key={group.label} className="space-y-1">
                {!collapsed && (
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => (
                  <SidebarLink
                    key={item.to}
                    item={item}
                    active={isActive(pathname, item)}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div
            className={`flex shrink-0 items-center gap-2 border-t border-hairline p-3 ${
              collapsed ? "flex-col" : ""
            }`}
          >
            <CartButton />
            <div className={collapsed ? "" : "ml-auto"}>
              <UserMenu />
            </div>
          </div>
        </aside>

        {/* mobile top bar */}
        <header className="sticky top-0 z-30 border-b border-hairline bg-background/80 backdrop-blur-md lg:hidden">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger
                aria-label="Open menu"
                className="grid size-9 place-items-center rounded-lg bg-secondary ring-1 ring-hairline transition hover:bg-accent active:scale-95"
              >
                <Menu className="size-5" />
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetHeader className="border-b border-hairline px-5 py-4 text-left">
                  <SheetTitle className="flex items-center gap-2.5">
                    <img
                      src="/logo.webp"
                      width={28}
                      height={28}
                      alt=""
                      className="h-7 w-auto rounded-md object-contain"
                    />
                    SAZ Industrial
                  </SheetTitle>
                </SheetHeader>
                <nav className="space-y-5 overflow-y-auto p-3">
                  {groups.map((group) => (
                    <div key={group.label} className="space-y-1">
                      <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {group.label}
                      </p>
                      {group.items.map((item) => (
                        <SidebarLink
                          key={item.to}
                          item={item}
                          active={isActive(pathname, item)}
                          collapsed={false}
                          onNavigate={() => setDrawerOpen(false)}
                        />
                      ))}
                    </div>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>

            <Link to="/inventory" className="flex min-w-0 items-center gap-2">
              <img
                src="/logo.webp"
                alt=""
                width={28}
                height={28}
                className="size-7 rounded-md object-contain"
              />
              <span className="truncate text-sm font-semibold tracking-tight">SAZ Industrial</span>
            </Link>

            <div className="flex items-center gap-2">
              <CartButton />
              <UserMenu />
            </div>
          </div>
        </header>

        <div className="lg:pl-[var(--sidebar-w)] lg:transition-[padding] lg:duration-300 lg:ease-out">
          {children}
        </div>
      </div>
    </TooltipProvider>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const link = (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-3 rounded-xl py-2.5 text-sm font-medium transition ${
        collapsed ? "justify-center px-2" : "px-3"
      } ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      <item.icon className="size-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );

  // Collapsed to an icon rail, the label has to come back on hover or the rail
  // is a guessing game.
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The one horizontal inset every page uses.
 *
 * Pages used to pick their own container — max-w-7xl here, max-w-5xl there,
 * max-w-4xl on Organization — so no two pages lined up, and on a wide screen
 * the content sat in a narrow ribbon with the sidebar already eating 264px.
 * <PageHeader> and <PageBody> both read this constant, so a page's toolbar and
 * its content are always on the same gridlines.
 */
export const PAGE_X = "px-4 sm:px-6 lg:px-8";

/**
 * Full-width content area for a page, matched to <PageHeader>'s inset.
 * Use this instead of hand-rolling a <main> with its own max width.
 */
export function PageBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <main
      className={`w-full animate-in fade-in slide-in-from-bottom-3 py-6 duration-500 ease-out lg:py-8 ${PAGE_X} ${className}`}
    >
      {children}
    </main>
  );
}

/**
 * Sticky per-page toolbar. Sits at the very top of the content column on
 * desktop, and directly under the mobile top bar on small screens.
 * Holds the page title, page actions, and an optional filter row (`children`).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasTopRow = title || subtitle || actions || meta;
  return (
    <div className="sticky top-14 z-20 border-b border-hairline bg-background/80 backdrop-blur-md lg:top-0">
      <div className={`flex w-full flex-col gap-3 py-3 lg:min-h-16 lg:justify-center ${PAGE_X}`}>
        {hasTopRow && (
          <div className="flex items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              {title && (
                <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
                  {title}
                </h1>
              )}
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {meta}
              {actions}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
