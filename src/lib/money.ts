/**
 * How money is written, everywhere in the app.
 *
 * Twelve files each built their own Intl formatter, which is how the same
 * figure ended up with different decimal handling depending on which screen you
 * read it on. There is one here instead.
 *
 * The sign goes on the NUMBER, not on the currency: `PKR -5,000`, never
 * `-PKR 5,000`. The second reads as a negative currency and puts the minus
 * furthest from the digits it applies to — easy to miss entirely when a column
 * of figures is scanned quickly, which is exactly when a loss must not be
 * mistaken for a gain. Intl has no option for this, so the sign is moved after
 * the currency prefix.
 */
const whole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

const exact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 2,
});

function signed(n: number, f: Intl.NumberFormat) {
  const v = Number.isFinite(n) ? n : 0;
  const abs = f.format(Math.abs(v));
  // An amount too small to show is not a negative amount: rounding −0.4 to
  // "PKR -0" invents a loss out of a rounding error.
  if (v >= 0 || abs === f.format(0)) return abs;
  // Insert the minus after everything that is not a digit — the currency code
  // and the space Intl puts after it.
  return abs.replace(/^([^\d]*)/, "$1-");
}

/** Rounded to whole rupees. The default: tills and reports deal in rupees. */
export function money(n: number) {
  return signed(n, whole);
}

/** Keeps paisa when there is any — for ledgers and tooltips, where a figure is
 *  being reconciled rather than glanced at. */
export function moneyExact(n: number) {
  return signed(n, exact);
}
