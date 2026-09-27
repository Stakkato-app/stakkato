/* Instrument icons, inline SVG so they pick up the role colour through currentColor. */

export var ICONS = {
    drums:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<rect x="2.6" y="3" width="19" height="2.6" rx="1.3" transform="rotate(-18 12 4.3)"/>'+
      '<rect x="6.4" y="3" width="19" height="2.6" rx="1.3" transform="rotate(18 16 4.3)"/>'+
      '<path d="M4 20.5 1.6 25.4a1.2 1.2 0 0 0 2.1 1.1L6.3 22Z"/>'+
      '<path d="M24 20.5l2.4 4.9a1.2 1.2 0 0 1-2.1 1.1L21.7 22Z"/>'+
      '<path d="M3 12.5h22a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z"/>'+
      '<g fill="var(--paper)"><rect x="6" y="14.4" width="1.6" height="4.7" rx=".8"/>'+
      '<rect x="13.2" y="14.4" width="1.6" height="4.7" rx=".8"/>'+
      '<rect x="20.4" y="14.4" width="1.6" height="4.7" rx=".8"/></g></svg>',
    guitar:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<g transform="rotate(-38 14 14)">'+
      '<rect x="12.4" y="1.2" width="3.2" height="3.8" rx=".8"/>'+
      '<rect x="12.9" y="4.4" width="2.2" height="11"/>'+
      '<path d="M14 14.2c3.9 0 6.9 2.6 6.9 6.1 0 3.4-3 5.9-6.9 5.9s-6.9-2.5-6.9-5.9c0-3.5 3-6.1 6.9-6.1Z"/>'+
      '<g fill="var(--paper)"><rect x="10.2" y="17.6" width="7.6" height="1.9" rx=".5"/>'+
      '<circle cx="14" cy="22.6" r="1.5"/></g></g></svg>',
    bass:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<path d="M4 2.5h20a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-19a2 2 0 0 1 2-2Z"/>'+
      '<g fill="var(--paper)"><circle cx="14" cy="16.6" r="6.1"/>'+
      '<circle cx="8.2" cy="6.6" r="1.9"/><circle cx="14" cy="6.6" r="1.9"/><circle cx="19.8" cy="6.6" r="1.9"/></g>'+
      '<circle cx="14" cy="16.6" r="2.4"/></svg>',
    atmos:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<path d="M7.4 22.5a5.4 5.4 0 0 1-.8-10.7 7.3 7.3 0 0 1 14-1.7 5.9 5.9 0 0 1 .3 12.4Z"/>'+
      '<g fill="none" stroke="var(--paper)" stroke-width="1.9" stroke-linecap="round">'+
      '<path d="M6.6 17.4c1.5-2.2 3-2.2 4.5 0s3 2.2 4.5 0 3-2.2 4.5 0"/></g></svg>',
    wild:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<rect x="2.5" y="2.5" width="23" height="23" rx="5"/>'+
      '<g fill="var(--paper)"><circle cx="9" cy="9" r="2.1"/><circle cx="19" cy="9" r="2.1"/>'+
      '<circle cx="14" cy="14" r="2.1"/><circle cx="9" cy="19" r="2.1"/><circle cx="19" cy="19" r="2.1"/></g></svg>',
    seed:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<path d="M14 3.5a4.3 4.3 0 0 1 4.3 4.3v5.4a4.3 4.3 0 0 1-8.6 0V7.8A4.3 4.3 0 0 1 14 3.5Z"/>'+
      '<path d="M7 12.4a1.3 1.3 0 0 1 2.6 0 4.4 4.4 0 0 0 8.8 0 1.3 1.3 0 0 1 2.6 0 7 7 0 0 1-5.7 6.9v3.3h2.6a1.3 1.3 0 0 1 0 2.6h-7.8a1.3 1.3 0 0 1 0-2.6h2.6v-3.3A7 7 0 0 1 7 12.4Z"/></svg>',
    prod:'<svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">'+
      '<rect x="2" y="12" width="3.4" height="11" rx="1.2"/><rect x="8.2" y="5" width="3.4" height="18" rx="1.2"/>'+
      '<rect x="16.4" y="9" width="3.4" height="14" rx="1.2"/><rect x="22.6" y="15" width="3.4" height="8" rx="1.2"/>'+
      '<g fill="var(--paper)"><rect x="1" y="16" width="5.4" height="2.2" rx="1.1"/>'+
      '<rect x="7.2" y="11" width="5.4" height="2.2" rx="1.1"/>'+
      '<rect x="15.4" y="17" width="5.4" height="2.2" rx="1.1"/>'+
      '<rect x="21.6" y="18.6" width="5.4" height="2.2" rx="1.1"/></g></svg>'
  };
export function ico(id, color){ return '<span class="ico" style="color:' + color + '" aria-hidden="true">' + ICONS[id] + '</span>'; }
