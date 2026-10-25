// One outline icon set, 1.5px stroke on a 16px grid, drawn here so nothing loads from a CDN.
import { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  today: () => (
    <Svg>
      <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" />
    </Svg>
  ),
  record: () => (
    <Svg>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
    </Svg>
  ),
  entries: () => (
    <Svg>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" strokeWidth={2} />
    </Svg>
  ),
  udhaar: () => (
    <Svg>
      <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2v-9Z" />
      <path d="M3 11.5a2 2 0 0 1 2-2h7.5M6 5.5h3.5" />
    </Svg>
  ),
  books: () => (
    <Svg>
      <path d="M8 2.5v11M3 5h3M3 8h3M10 5h3M10 8h3M2.5 2.5h11v11h-11z" />
    </Svg>
  ),
  stock: () => (
    <Svg>
      <path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11V5Z" />
      <path d="M2.5 5 8 7.5 13.5 5M8 7.5v6" />
    </Svg>
  ),
  words: () => (
    <Svg>
      <path d="M2.5 13 6 3l3.5 10M3.75 9.5h4.5M10.5 8.5h3M12 7v3" />
    </Svg>
  ),
  devices: () => (
    <Svg>
      <rect x="1.75" y="3.5" width="5.5" height="9.5" rx="1.25" />
      <rect x="8.75" y="3.5" width="5.5" height="9.5" rx="1.25" />
      <path d="M4.5 11h.01M11.5 11h.01" strokeWidth={2} />
    </Svg>
  ),
  chevron: () => (
    <Svg size={14}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  ),
  menu: () => (
    <Svg size={20}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  ),
  close: () => (
    <Svg size={20}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  upload: () => (
    <Svg size={20}>
      <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
    </Svg>
  ),
  sync: () => (
    <Svg>
      <path d="M13 6a5.25 5.25 0 0 0-9.6-1.5M3 10a5.25 5.25 0 0 0 9.6 1.5" />
      <path d="M13 2.5V6H9.5M3 13.5V10h3.5" />
    </Svg>
  ),
  check: () => (
    <Svg size={14}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  ),
  alert: () => (
    <Svg size={14}>
      <path d="M8 5.5v3.25M8 11h.01" />
      <path d="M7.13 2.5 1.9 11.75A1 1 0 0 0 2.77 13.25h10.46a1 1 0 0 0 .87-1.5L8.87 2.5a1 1 0 0 0-1.74 0Z" />
    </Svg>
  ),
};

/** The product's mark: two ledger columns with the line of speech running between them. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="7" fill="var(--text)" />
      <path d="M9 7v14M19 7v14" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" opacity="0.45" />
      <path
        d="M5 14h2.5l1.5-3 2 6 2-8 2 7 1.5-2H23"
        fill="none"
        stroke="var(--surface)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
