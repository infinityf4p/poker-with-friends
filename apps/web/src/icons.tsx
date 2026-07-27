import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'book'
  | 'cards'
  | 'check'
  | 'chevron'
  | 'chip'
  | 'clock'
  | 'close'
  | 'copy'
  | 'crown'
  | 'door'
  | 'eye'
  | 'history'
  | 'key'
  | 'lock'
  | 'logout'
  | 'pause'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'rotate'
  | 'shield'
  | 'sound'
  | 'sound-off'
  | 'spade'
  | 'spark'
  | 'table'
  | 'user'
  | 'users'
  | 'warning'
  | 'wifi';

const paths: Record<IconName, ReactNode> = {
  'arrow-left': <path d="m15 18-6-6 6-6" />,
  'arrow-right': <path d="m9 18 6-6-6-6" />,
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a2 2 0 0 1 2 2v16a3 3 0 0 0-3-3H4V5.5Z" />
      <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18a3 3 0 0 1 3-3h4V5.5Z" />
      <path d="M7 8h3M7 11h3M16 8h1M16 11h1" />
    </>
  ),
  cards: (
    <>
      <rect x="3" y="5" width="13" height="17" rx="2" />
      <path d="m8 11 1.5-2 1.5 2-1.5 2L8 11Z" />
      <path d="m13 2 6.5 2.2a2 2 0 0 1 1.3 2.5L17 18" />
    </>
  ),
  check: <path d="m20 6-11 11-5-5" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  chip: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M18.4 5.6l-3.5 3.5M9.1 14.9l-3.5 3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  crown: <path d="m3 7 4 4 5-7 5 7 4-4-2 11H5L3 7Zm3 14h12" />,
  door: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2 2M14 9l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  logout: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 6v5h-5M4 18v-5h5" />
      <path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 11M4 13l2.4 4.6A7 7 0 0 0 17.9 15" />
    </>
  ),
  rotate: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9" />
      <path d="M21 3v5h-5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
  sound: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  'sound-off': (
    <>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  spade: (
    <path d="M12 3C9 7.6 4.5 10.4 4.5 14.2A4.6 4.6 0 0 0 9 19c1.1 0 2.1-.4 3-1v3H9.5v1h5v-1H12v-3c.9.6 1.9 1 3 1a4.6 4.6 0 0 0 4.5-4.8C19.5 10.4 15 7.6 12 3Z" />
  ),
  spark: (
    <path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3ZM5 16l.7 2.3L8 19l-2.3.7L5 22l-.7-2.3L2 19l2.3-.7L5 16ZM19 14l.7 2.3 2.3.7-2.3.7L19 20l-.7-2.3-2.3-.7 2.3-.7L19 14Z" />
  ),
  table: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="6" />
      <path d="M7 18v3M17 18v3M7 6V3M17 6V3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 3.6 2.2 18a2 2 0 0 0 1.8 3h16a2 2 0 0 0 1.8-3L13.7 3.6a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  wifi: <path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01" />,
};

export function Icon({
  name,
  size = 20,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
