// The mark of the bridge: a cooking pot under an arc that ends in an arrow, the recipe on
// its way from Mealie to the machine, white on a warm orange tile. The pages inline it; the
// asset build turns it into the favicon and the PNG app icons.

export const LOGO_ORANGE = "#ea580c";

const MARK = [
  // The arc with its arrowhead.
  '<path d="M9 11.5Q16 4.5 23 11.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  '<path d="M19.3 11.1 23 11.5l-.6-3.7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  // The pot: rim, body and handles.
  '<path d="M6 15.2h20" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  '<path d="M8 17h16v3.6a4.4 4.4 0 0 1-4.4 4.4h-7.2A4.4 4.4 0 0 1 8 20.6z" fill="#fff"/>',
  '<path d="M4.6 18.4H7M25 18.4h2.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
].join("");

// The mark as a standalone SVG document. Full bleed for app icons that the platform rounds
// itself, a rounded tile otherwise.
export function logoSvg(options: { size?: number; fullBleed?: boolean } = {}): string {
  const size = options.size ?? 32;
  const radius = options.fullBleed ? 0 : 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="${radius}" fill="${LOGO_ORANGE}"/>${MARK}</svg>`;
}

// The mark for the page markup: decorative, the text next to it names the app.
export function logoMarkup(className: string): string {
  return `<svg class="${className}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" fill="${LOGO_ORANGE}"/>${MARK}</svg>`;
}
