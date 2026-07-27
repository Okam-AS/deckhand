import type { ProofFact } from "./content.ts";

export interface ProofStripProps {
  facts: readonly ProofFact[];
}

export function ProofStrip({ facts }: ProofStripProps) {
  return (
    <section className="proof-section section-shell" aria-label="Verified Deckhand capabilities">
      <ul className="proof-strip">
        {facts.map((fact) => (
          <li key={fact.label}>
            <span className="proof-status" aria-hidden="true" />
            <div>
              <strong>{fact.label}</strong>
              <p>{fact.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
