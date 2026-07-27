import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function ArrowIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M5 12h13M14 7l5 5-5 5" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M10 5h4M11 18.5h2" />
    </svg>
  );
}

export function AndroidIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m8 5-2-2M16 5l2-2M6 10h12v7.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM7 8a5.5 5.5 0 0 1 10 0" />
      <path d="M9.5 13h.01M14.5 13h.01" />
    </svg>
  );
}

export function BrowserIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M2.5 8.5h19M6 6.25h.01M9 6.25h.01" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="4.5" y="10" width="15" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M12 2.5c.8 4.6 2.9 6.7 7.5 7.5-4.6.8-6.7 2.9-7.5 7.5-.8-4.6-2.9-6.7-7.5-7.5 4.6-.8 6.7-2.9 7.5-7.5Z" />
      <path d="M19 16.5c.25 1.5 1 2.25 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.25 2.25-1 2.5-2.5Z" />
    </svg>
  );
}

export function CloudKeyIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M7 17.5H5.5A3.5 3.5 0 0 1 5 10.54 6 6 0 0 1 16.3 8.1 4.5 4.5 0 0 1 18.5 17H17" />
      <circle cx="11" cy="15" r="2.25" />
      <path d="M13.2 15H20l1 1-1.3 1.3-1-1-1.2 1.2" />
    </svg>
  );
}

export function MachineIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="4" y="3.5" width="16" height="12" rx="2" />
      <path d="M2.5 19.5h19M9 15.5l-1 4M15 15.5l1 4" />
    </svg>
  );
}
