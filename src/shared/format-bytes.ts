const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** A size in the interface language, in decimal units from bytes up to gigabytes: "1,5 MB" in Italian, "8.1 GB" in English. */
export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}
