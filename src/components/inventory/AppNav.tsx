import { Link, useLocation } from "@tanstack/react-router";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Boxes, ShoppingCart, Truck, BarChart3, Wallet, Menu, Building2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { UserMenu } from "@/components/inventory/UserMenu";
import { CartButton } from "@/components/cart/CartButton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useOrg } from "@/hooks/use-org";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Admin-only destination. Employees never see the tab, and the route itself
   *  redirects them away — see the beforeLoad guards on those routes. */
  adminOnly?: boolean;
}

// Primary destinations, shared by the desktop tab bar and the mobile dock.
//
// Employees get Inventory (read-only), Sales and Pending. Purchases and Reports
// are admin-only: both expose purchase cost and therefore profit margin.
const NAV: NavItem[] = [
  { to: "/inventory", label: "Inventory", icon: Boxes },
  { to: "/sales", label: "Sales", icon: ShoppingCart },
  { to: "/pending-payments", label: "Pending", icon: Wallet },
  { to: "/purchases", label: "Purchases", icon: Truck, adminOnly: true },
  { to: "/reports", label: "Reports", icon: BarChart3, adminOnly: true },
  { to: "/organization", label: "Organization", icon: Building2, adminOnly: true },
];

/**
 * Persistent app chrome: a sticky top bar (brand + desktop tabs + account) with a
 * right-side navigation drawer on mobile (hamburger). Rendered ONCE in the
 * authenticated layout so it survives navigation — the active-tab indicator glides
 * instead of remounting. Page-specific controls live in <PageHeader>, not here.
 */
export function AppNav() {
  const { pathname } = useLocation();
  const { isAdmin } = useOrg();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Filter once and use this list everywhere below. The sliding pill indexes
  // into the rendered links, so the desktop tabs, the mobile drawer and the
  // active-index lookup all have to walk the SAME array — filtering per-render
  // site would put the pill under the wrong tab.
  const nav = useMemo(() => NAV.filter((n) => isAdmin || !n.adminOnly), [isAdmin]);
  const activeIndex = nav.findIndex(
    (n) => pathname === n.to || pathname.startsWith(`${n.to}/`),
  );

  const navRef = useRef<HTMLElement>(null);
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [pill, setPill] = useState<{ left: number; width: number; show: boolean }>({
    left: 0,
    width: 0,
    show: false,
  });

  // Slide the highlight pill under the active desktop tab. Recompute on route
  // change and on resize so the indicator always tracks the active link.
  useLayoutEffect(() => {
    const measure = () => {
      const el = linkRefs.current[activeIndex];
      if (!el) {
        setPill((p) => ({ ...p, show: false }));
        return;
      }
      // offsetLeft/Width are relative to the positioned <nav> parent and read
      // from the already-computed layout — no forced reflow per route change.
      setPill({ left: el.offsetLeft, width: el.offsetWidth, show: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeIndex]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-hairline bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:h-16">
          <Link to="/inventory" className="flex shrink-0 items-center gap-2.5">
            <img
              src="/logo.webp"
              alt="SAZ Industrial"
              width={36}
              height={36}
              className="h-8 w-auto rounded-md object-contain"
            />
            <span className="hidden text-base font-semibold tracking-tight sm:inline">
              SAZ Industrial
            </span>
          </Link>

          <nav
            ref={navRef}
            className="relative hidden items-center gap-1 rounded-full bg-surface p-1 ring-1 ring-hairline md:flex"
          >
            {/* Sliding active indicator */}
            <span
              aria-hidden
              className="absolute top-1 bottom-1 rounded-full bg-primary shadow-sm transition-all duration-300 ease-out"
              style={{ left: pill.left, width: pill.width, opacity: pill.show ? 1 : 0 }}
            />
            {nav.map((n, i) => {
              const isActive = i === activeIndex;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  ref={(el) => {
                    linkRefs.current[i] = el;
                  }}
                  className={`relative z-10 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-300 ${
                    isActive
                      ? "text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <n.icon className="size-4" />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <CartButton />
            <UserMenu />
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger
                aria-label="Open menu"
                className="grid size-9 place-items-center rounded-lg bg-secondary ring-1 ring-hairline transition hover:bg-accent active:scale-95 md:hidden"
              >
                <Menu className="size-5" />
              </SheetTrigger>
              <SheetContent side="right" className="w-72 p-0">
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
                <nav className="flex flex-col gap-1 p-3">
                  {nav.map((n) => (
                    <Link
                      key={n.to}
                      to={n.to}
                      onClick={() => setDrawerOpen(false)}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                      activeProps={{ className: "bg-primary/10 text-primary hover:bg-primary/10" }}
                      activeOptions={{ exact: false }}
                    >
                      <n.icon className="size-5" />
                      {n.label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
    </>
  );
}

/**
 * Sticky per-page toolbar that sits directly under the persistent AppNav.
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
    <div className="sticky top-14 z-20 border-b border-hairline bg-background/80 backdrop-blur-md lg:top-16">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6">
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
