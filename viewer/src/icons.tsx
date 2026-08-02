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

/**
 * Brand glyphs are FILLED, not stroked like the rest of this file. An Apple or
 * Android mark drawn as an outline stops being recognisable — the whole value of a
 * logo here is that it is identified without being read.
 */
function BrandSvg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" stroke="none" aria-hidden>
      {children}
    </svg>
  );
}

export function AppleIcon(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </BrandSvg>
  );
}

export function AndroidIcon(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M17.523 15.341a1 1 0 110-2 1 1 0 010 2m-11.046 0a1 1 0 110-2 1 1 0 010 2m11.405-6.02 1.997-3.459a.416.416 0 00-.72-.416l-2.022 3.503C15.59 8.244 13.853 7.851 12 7.851s-3.59.393-5.137 1.099L4.841 5.447a.416.416 0 00-.72.416l1.997 3.459C2.689 11.187.343 14.659 0 18.761h24c-.344-4.102-2.689-7.574-6.118-9.44" />
    </BrandSvg>
  );
}

/**
 * The platform's mark, chosen in ONE place.
 *
 * Rendered in both chromes — the desktop caption and the phone dock's info popover —
 * and a second copy of this ternary is how they drift into disagreeing about what a
 * platform is called. `null` for anything unrecognised (web, or a platform added
 * later): a missing glyph is quieter than a wrong one.
 */
export function PlatformGlyph({ platform, size = 14 }: { platform?: string; size?: number }) {
  if (platform === "ios") return <AppleIcon size={size} />;
  if (platform === "android") return <AndroidIcon size={size} />;
  return null;
}

export function GitHubIcon(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </BrandSvg>
  );
}

/** Stroked, not filled: this is a UI icon like Home or Rotate, not a brand mark. */
export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  );
}

/**
 * The repo's mark — GitHub, or nothing.
 *
 * Deckhand only fetches from GitHub, so anything that IS a repo is a GitHub repo. But
 * `repo` falls back to the app's id for a local app with no remote (server: `p.app.repo
 * ?? p.app.id`), and a bare id is not a repository at all. A slash is what separates the
 * two, and where we cannot tell we show nothing — a missing glyph is quieter than a
 * wrong one, the same rule PlatformGlyph follows.
 */
export function RepoGlyph({ repo, size = 14 }: { repo?: string; size?: number }) {
  return repo?.includes("/") ? <GitHubIcon size={size} /> : null;
}
