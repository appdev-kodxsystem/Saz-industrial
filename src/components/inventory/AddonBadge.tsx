import { Gift } from "lucide-react";

/**
 * Marks a row as an add-on rather than a machine.
 *
 * The two live side by side on a purchase and are shaped differently — a
 * machine is one unit with a serial, an add-on is a batch of many — so they must
 * never be read as the same kind of thing at a glance. The label is spelled out
 * rather than left as a bare icon, because an unlabelled icon is a legend the
 * reader has to already know.
 */
export function AddonBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary ${className}`}
    >
      <Gift className="size-2.5" />
      Add-on
    </span>
  );
}
