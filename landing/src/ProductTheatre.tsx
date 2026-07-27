export function ProductTheatre() {
  return (
    <figure className="hero-visual product-theatre">
      <div className="hero-art-frame">
        <img
          src="/deckhand-hero.png"
          alt="A quiet developer workspace representing Deckhand running locally on a Mac"
          width="1568"
          height="1003"
          fetchPriority="high"
        />
      </div>
      <figcaption className="hero-art-caption">
        <span>
          <i aria-hidden="true" />
          Local workspace
        </span>
        <strong>Source and native toolchains stay here.</strong>
        <small>Deckhand runs beside them</small>
      </figcaption>
    </figure>
  );
}
