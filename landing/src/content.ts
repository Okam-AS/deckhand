export interface PricingPlan {
  name: "Solo" | "Lifetime";
  amount: string;
  cadence: string;
  detail: string;
  features: readonly string[];
  featured?: boolean;
  cta: string;
}

export interface TrialOffer {
  amount: string;
  detail: string;
  features: readonly string[];
}

export interface WorkflowStep {
  number: string;
  title: string;
  description: string;
}

export interface ProofFact {
  label: string;
  description: string;
}

export interface RunTarget {
  id: "ios" | "android" | "web";
  kind: "device" | "process";
  label: string;
  target: string;
  phases: readonly string[];
  proof: string;
}

export const productFacts = {
  slogan: "Your code. Always on your machine.",
  localOwnership: "Your machine · your tester · your code.",
  connectorRole: "Public by design",
  pairingGate: "Pairing code",
  localRole: "Builds, boots, controls, and streams on your Mac",
  platforms: "iOS, Android, and web",
} as const;

export const proofFacts: readonly ProofFact[] = [
  {
    label: "Fully local tester",
    description: "You own and run Deckhand on your Mac.",
  },
  {
    label: "Build once per platform",
    description: "Install the same build across every selected device.",
  },
  {
    label: "Parallel device boots",
    description: "Bring up iOS, Android, and web together.",
  },
  {
    label: "Stable share links",
    description: "Return to the same preview URL after a rebuild.",
  },
] as const;

export const runTargets: readonly RunTarget[] = [
  {
    id: "ios",
    kind: "device",
    label: "iOS simulator",
    target: "iPhone 17 Pro · iOS 26",
    phases: ["Build reused", "Booted", "Installed", "Stream ready"],
    proof: "Live stream · touch + keyboard",
  },
  {
    id: "android",
    kind: "device",
    label: "Android emulator",
    target: "Pixel 7 · API 29",
    phases: ["Build reused", "Booted", "Installed", "Stream ready"],
    proof: "ADB stream · full input control",
  },
  {
    id: "web",
    kind: "process",
    label: "Local web process",
    target: "Vite · 127.0.0.1",
    phases: ["Dev server started", "Health check passed", "Proxy ready"],
    proof: "Stable local preview",
  },
] as const;

export const workflowSteps: readonly WorkflowStep[] = [
  {
    number: "01",
    title: "Ask in plain English",
    description: "Name the app, branch or PR, and the devices you want. Your coding agent handles the rest.",
  },
  {
    number: "02",
    title: "Build on your Mac",
    description: "Deckhand checks out the code, builds once per platform, and boots every device in parallel.",
  },
  {
    number: "03",
    title: "Open one live link",
    description: "Watch and control every preview in a calm browser view—or let your agent test it first.",
  },
] as const;

export const trialOffer: TrialOffer = {
  amount: "14 days free",
  detail: "Run the complete local workflow before choosing a plan.",
  features: ["All supported platforms", "Live share links", "No credit card required"],
};

export const paidPricingPlans: readonly PricingPlan[] = [
  {
    name: "Solo",
    amount: "NOK 300",
    cadence: "per month",
    detail: "One developer, up to two machines.",
    features: ["Two registered machines", "Unlimited local previews", "Public or PIN-protected links"],
    featured: true,
    cta: "Choose Solo",
  },
  {
    name: "Lifetime",
    amount: "NOK 10,000",
    cadence: "one-time",
    detail: "One purchase, up to two machines.",
    features: ["Single lifetime purchase", "Two registered machines", "All current core features"],
    cta: "Buy lifetime",
  },
] as const;

export function buildTrialRequestHref(plan: string): string {
  const query = new URLSearchParams({
    title: `Trial access request · ${plan}`,
    body: `I'd like to request Deckhand trial access for the ${plan} plan.`,
  });
  return `https://github.com/Okam-AS/deckhand/issues/new?${query.toString()}`;
}
