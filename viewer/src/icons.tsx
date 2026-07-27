// Shared stroke icons (lucide-style: 24-box, stroke 2, round caps).

interface IconProps {
  size?: number;
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

/** A device with an arrow curling over its corner — reads as "rotate device", not refresh. */
export function RotateIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8" y="9" width="12" height="12" rx="2.5" />
      <path d="M4 12V9a5 5 0 0 1 5-5h3" />
      <path d="M9.5 1.5 12 4 9.5 6.5" />
    </Svg>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3m8 0v-3a2 2 0 0 1 2-2h3" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </Svg>
  );
}

/** Sliders — the mobile controls button. */
export function ControlsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 5h-7M10 5H3M21 12h-9M8 12H3M21 19h-5M12 19H3" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="14" cy="19" r="2" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h0M18 14h0M9 14h6" />
    </Svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function SwitchDeviceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="2" width="10" height="16" rx="2" />
      <path d="M9 15h.01" />
      <path d="M18 9v9a2 2 0 0 1-2 2H9" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5M12 8h.01" />
    </Svg>
  );
}

/** Delete-left (backspace) — the only non-digit key on the PIN pad. */
export function BackspaceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z" />
      <path d="m12 9 6 6M18 9l-6 6" />
    </Svg>
  );
}
