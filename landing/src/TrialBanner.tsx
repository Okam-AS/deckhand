import type { TrialOffer } from "./content.ts";
import { buildTrialRequestHref } from "./content.ts";
import { ArrowIcon, CheckIcon, SparkIcon } from "./icons.tsx";

export interface TrialBannerProps {
  offer: TrialOffer;
}

export function TrialBanner({ offer }: TrialBannerProps) {
  return (
    <aside className="trial-banner" aria-label="Deckhand trial offer">
      <div className="trial-banner-copy">
        <p className="kicker">
          <SparkIcon />
          Try the complete local tester
        </p>
        <h3>{offer.amount}</h3>
        <p>{offer.detail}</p>
      </div>
      <ul>
        {offer.features.map((feature) => (
          <li key={feature}>
            <CheckIcon />
            {feature}
          </li>
        ))}
      </ul>
      <div className="trial-banner-action">
        <a
          className="button button-primary"
          href={buildTrialRequestHref("Trial")}
          rel="noreferrer"
          target="_blank"
        >
          Request a trial key
          <ArrowIcon />
        </a>
        <small>Trial access is currently provisioned directly.</small>
      </div>
    </aside>
  );
}
