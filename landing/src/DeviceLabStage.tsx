import type { RunTarget } from "./content.ts";
import { AndroidIcon, BrowserIcon, CheckIcon, LockIcon, PhoneIcon, TerminalIcon } from "./icons.tsx";

export interface DeviceLabStageProps {
  targets: readonly RunTarget[];
}

const targetIcons = {
  ios: PhoneIcon,
  android: AndroidIcon,
  web: BrowserIcon,
} as const;

export function DeviceLabStage({ targets }: DeviceLabStageProps) {
  return (
    <section className="platforms section-shell section-block">
      <div className="section-heading heading-row">
        <div>
          <p className="kicker">One request. Every selected target.</p>
          <h2>Your local test run, in one view.</h2>
        </div>
        <p>Deckhand builds once per platform, boots devices in parallel, and returns one stable viewer URL.</p>
      </div>

      <div className="run-console" aria-label="Example Deckhand local test run">
        <header className="run-console-bar">
          <span className="run-window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="run-console-title">
            <TerminalIcon />
            deckhand / start_preview
          </span>
          <strong>
            <i aria-hidden="true" />
            LOCAL · YOUR MAC
          </strong>
        </header>

        <div className="run-request">
          <span className="run-step-number">01</span>
          <div>
            <small>Agent request</small>
            <strong>“Open AdminApp on the selected iOS and Android targets, then return the viewer.”</strong>
          </div>
          <code>AdminApp · local checkout</code>
        </div>

        <div className="run-engine">
          <div className="run-engine-copy">
            <span className="run-step-number">02</span>
            <div>
              <small>Deckhand MCP server</small>
              <strong>Build once. Boot in parallel.</strong>
              <p>The server orchestrates installed toolchains directly on this machine.</p>
            </div>
          </div>
          <span className="run-engine-status">
            <i aria-hidden="true" />
            Orchestrating 3 targets
          </span>
        </div>

        <div className="run-targets" aria-label="Targets started by the same request">
          {targets.map((target) => {
            const Icon = targetIcons[target.id];
            return (
              <article className={`run-target run-target-${target.id}`} key={target.id}>
                <div className="run-target-head">
                  <span className="run-target-icon">
                    <Icon />
                  </span>
                  <div>
                    <small>{target.label}</small>
                    <strong>{target.target}</strong>
                  </div>
                  <span className="run-ready">
                    <i aria-hidden="true" />
                    Ready
                  </span>
                </div>
                <ol className="run-phases">
                  {target.phases.map((phase) => (
                    <li key={phase}>
                      <CheckIcon />
                      {phase}
                    </li>
                  ))}
                </ol>
                <p>{target.proof}</p>
              </article>
            );
          })}
        </div>

        <div className="run-output">
          <span className="run-step-number">03</span>
          <LockIcon />
          <div>
            <small>One stable viewer URL</small>
            <code>deckhand.your-domain.com/s/••••••</code>
          </div>
          <strong>
            <i aria-hidden="true" />
            3 previews ready
          </strong>
        </div>

        <footer className="run-console-footer">
          <span>Source, builds, and device control never leave this machine.</span>
          <span>Build once per platform · install on every selected device</span>
        </footer>
      </div>
    </section>
  );
}
