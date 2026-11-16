/**
 * The icon of a .pyxis file at small sizes: a white sheet with a path on it. The shapes are `pyxis-file-icon-32.svg` in
 * design-system/logo, the drawing the installers use at 32 px; the sheet is white in both themes, as the file's icon is.
 */
export function FileIcon({ size = 32 }: { size?: number }) {
  const sheet = "M124 32H318L416 130V452a28 28 0 0 1-28 28H124a28 28 0 0 1-28-28V60a28 28 0 0 1 28-28Z";
  return (
    <svg className="px-file-icon" width={size} height={size} viewBox="20 20 472 472" aria-hidden focusable="false">
      <path d={sheet} fill="#fff" />
      <path d={sheet} fill="none" stroke="#000" strokeOpacity=".17" strokeWidth="10" />
      <path d="M318 32V102a28 28 0 0 0 28 28H416Z" fill="#d6ddda" />
      <path d="M186 180V370" stroke="#c3cecb" strokeWidth="12" strokeLinecap="round" fill="none" />
      <circle cx="186" cy="180" r="36" fill="#14807a" />
      <circle cx="186" cy="280" r="26" fill="#fff" stroke="#14807a" strokeWidth="16" />
      <path
        fill="#f4b942"
        transform="translate(186 384) scale(6.5) translate(-50 -54)"
        d="M50,45 C51.62,52.38 51.62,52.38 59,54 C51.62,55.62 51.62,55.62 50,63 C48.38,55.62 48.38,55.62 41,54 C48.38,52.38 48.38,52.38 50,45Z"
      />
      <rect x="250" y="164" width="110" height="32" rx="16" fill="#c3cecb" />
      <rect x="250" y="264" width="84" height="32" rx="16" fill="#c3cecb" />
      <rect x="250" y="368" width="100" height="32" rx="16" fill="#dbe2df" />
    </svg>
  );
}
