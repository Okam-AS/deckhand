import {
  buildTrialRequestHref,
  paidPricingPlans,
  productFacts,
  proofFacts,
  runTargets,
  trialOffer,
  workflowSteps,
} from "./content.ts";
import { ProductTheatre } from "./ProductTheatre.tsx";
import { ProofStrip } from "./ProofStrip.tsx";
import { DeviceLabStage } from "./DeviceLabStage.tsx";
import { TrialBanner } from "./TrialBanner.tsx";
import {
  AndroidIcon,
  ArrowIcon,
  BrowserIcon,
  CheckIcon,
  CloudKeyIcon,
  LockIcon,
  MachineIcon,
  PhoneIcon,
  SparkIcon,
  TerminalIcon,
} from "./icons.tsx";

function Wordmark() {
  return (
    <a className="wordmark" href="#top" aria-label="Deckhand home">
      <span className="wordmark-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Deckhand</span>
    </a>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Wordmark />
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#security">Security</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <a
          className="button button-small button-ghost"
          href={buildTrialRequestHref("Trial")}
          rel="noreferrer"
          target="_blank"
        >
          Request trial
          <ArrowIcon />
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero section-shell" id="top">
      <div className="hero-copy">
        <div className="eyebrow">
          <SparkIcon />
          The fully local device tester for coding agents
        </div>
        <h1>
          Your code. <span>Always on your machine.</span>
        </h1>
        <p className="hero-promise">Your app. Any device. One prompt.</p>
        <p className="hero-lede">
          Own the tester, keep the source, and let your coding agent build, boot, and control iOS, Android, and
          web without sending your code to a remote build farm.
        </p>
        <div className="hero-actions">
          <a
            className="button button-primary"
            href={buildTrialRequestHref("Trial")}
            rel="noreferrer"
            target="_blank"
          >
            Request a trial
            <ArrowIcon />
          </a>
          <a className="text-link" href="#product">
            See how it works
          </a>
        </div>
        <ul className="trust-line" aria-label="Product highlights">
          <li>
            <span aria-hidden="true" />
            Runs on your Mac
          </li>
          <li>
            <span aria-hidden="true" />
            iOS, Android &amp; web
          </li>
          <li>
            <span aria-hidden="true" />
            Shareable previews
          </li>
        </ul>
      </div>

      <ProductTheatre />
    </section>
  );
}

function Workflow() {
  return (
    <section className="workflow section-shell section-block" id="product">
      <div className="section-heading">
        <p className="kicker">From request to running app</p>
        <h2>Skip the device-lab choreography.</h2>
        <p>
          Deckhand gives your coding agent a focused MCP surface for the work that normally pulls you away from
          the code.
        </p>
      </div>

      <ol className="workflow-signal" aria-label="Deckhand request flow">
        {["Agent request", "Local MCP server", "Device previews", "Stable share link"].map((label, index) => (
          <li key={label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>

      <div className="workflow-grid">
        <div className="steps-list">
          {workflowSteps.map((step) => (
            <article className="step" key={step.number}>
              <span className="step-number">{step.number}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="agent-card">
          <div className="agent-card-bar">
            <span className="agent-avatar">
              <SparkIcon />
            </span>
            <div>
              <strong>Coding agent</strong>
              <span>Connected to Deckhand</span>
            </div>
            <span className="live-label">
              <i />
              Online
            </span>
          </div>
          <blockquote>
            “Test the onboarding flow on iOS 26 and Android 14. Then send me the live preview.”
          </blockquote>
          <div className="agent-progress">
            <div className="progress-row done">
              <CheckIcon />
              <span>Build once per platform</span>
              <small>Done</small>
            </div>
            <div className="progress-row done">
              <CheckIcon />
              <span>Boot devices in parallel</span>
              <small>Done</small>
            </div>
            <div className="progress-row active">
              <span className="mini-spinner" />
              <span>Verify onboarding flow</span>
              <small>Running</small>
            </div>
          </div>
          <div className="link-preview">
            <LockIcon />
            <span>deckhand.example/s/••••••</span>
            <strong>Live preview</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function LocalFirst() {
  return (
    <section className="local-first section-block" id="security">
      <div className="section-shell local-grid">
        <div className="local-copy">
          <div className="eyebrow">
            <LockIcon />
            Local-first by design
          </div>
          <h2>Your source stays where the work happens.</h2>
          <p>
            Your connector URL is public by design — what keeps everyone else out is a pairing code minted on
            your Mac. A tunnel carries the request to that one machine, where source, builds, devices, previews,
            and streams stay. The Deckhand MCP server runs beside your checkouts and native toolchains.
          </p>
          <ul className="security-list">
            <li>
              <CheckIcon />
              No remote build farm
            </li>
            <li>
              <CheckIcon />
              Capability-bounded MCP tools
            </li>
            <li>
              <CheckIcon />
              Public or PIN-protected preview links
            </li>
          </ul>
        </div>

        <div className="architecture-card">
          <div className="architecture-top">
            <div className="architecture-icon cloud">
              <CloudKeyIcon />
            </div>
            <div>
              <span>Your connector URL</span>
              <strong>{productFacts.connectorRole}</strong>
            </div>
            <span className="scope-chip">No secret</span>
          </div>
          <div className="architecture-rail" aria-hidden="true">
            <span />
            <em>{productFacts.pairingGate}</em>
            <span />
          </div>
          <div className="architecture-local">
            <div className="local-head">
              <div className="architecture-icon machine">
                <MachineIcon />
              </div>
              <div>
                <span>{productFacts.localOwnership}</span>
                <strong>Deckhand MCP server</strong>
              </div>
              <span className="local-chip">
                <i />
                Local
              </span>
            </div>
            <p>{productFacts.localRole}</p>
            <div className="local-tools">
              <span>
                <TerminalIcon />
                Source
              </span>
              <span>
                <PhoneIcon />
                Simulators
              </span>
              <span>
                <AndroidIcon />
                Emulators
              </span>
              <span>
                <BrowserIcon />
                Streams
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section className="pricing section-block" id="pricing">
      <div className="section-shell">
        <div className="section-heading pricing-heading">
          <p className="kicker">Simple pricing</p>
          <h2>Own the tester. Choose your setup.</h2>
          <p>Every option keeps the code, builds, and device work on your machine.</p>
        </div>
        <TrialBanner offer={trialOffer} />
        <div className="pricing-grid">
          {paidPricingPlans.map((plan) => (
            <article className={`price-card${plan.featured ? " featured" : ""}`} key={plan.name}>
              {plan.featured && <span className="recommended">Recommended</span>}
              <div className="price-head">
                <h3>{plan.name}</h3>
                <p>{plan.detail}</p>
              </div>
              <p className="price">
                <strong>{plan.amount}</strong>
                <span>{plan.cadence}</span>
              </p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <CheckIcon />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                className={`button ${plan.featured ? "button-primary" : "button-secondary"}`}
                href={buildTrialRequestHref(plan.name)}
                rel="noreferrer"
                target="_blank"
              >
                {plan.cta}
                <ArrowIcon />
              </a>
            </article>
          ))}
        </div>
        <p className="public-repo-note">
          <SparkIcon />
          Free access for public repositories is being explored.
        </p>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="final-cta section-shell section-block" id="get-started">
      <div className="final-glow" aria-hidden="true" />
      <div className="eyebrow">
        <SparkIcon />
        Your local device lab is ready
      </div>
      <h2>Give your coding agent a pair of hands.</h2>
      <p>Start with a 14-day trial. One local MCP server, one pairing code, every device you need.</p>
      <div className="hero-actions">
        <a
          className="button button-primary"
          href={buildTrialRequestHref("Trial")}
          rel="noreferrer"
          target="_blank"
        >
          Request a trial
          <ArrowIcon />
        </a>
        <a className="text-link" href="#security">
          Review the architecture
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="section-shell footer-inner">
        <Wordmark />
        <p>Local device infrastructure for coding agents.</p>
        <nav aria-label="Footer navigation">
          <a href="#product">Product</a>
          <a href="#security">Security</a>
          <a href="#pricing">Pricing</a>
        </nav>
      </div>
    </footer>
  );
}

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <ProofStrip facts={proofFacts} />
        <Workflow />
        <LocalFirst />
        <DeviceLabStage targets={runTargets} />
        <Pricing />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
