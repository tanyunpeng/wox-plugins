// Result icons may be colorful; Action Panel icons must be monochrome and use
// var(--wox-theme-icon-color) so Wox can tint them (icons.md).
const svg = (data) => ({ ImageType: "svg", ImageData: data });

const shield = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#175ddc"/><path fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" d="M24 10l11 4v9c0 7-4.6 11.6-11 15-6.4-3.4-11-8-11-15v-9z"/><path fill="#fff" d="M24 19a3.2 3.2 0 0 0-1.6 6 3.2 3.2 0 0 0 4.6 3.6l-1.4 3-4-2v-2.6a5.6 5.6 0 1 1 5.6-5.6z"/></svg>',
);

const action = (paths) =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  );

// Row icons: Wox fetches and caches `url` images, so a login item can wear its
// own site's icon. Callers fall back to VAULT_ICON when there is no host.
const favicon = (host) => ({ ImageType: "url", ImageData: `https://${host}/favicon.ico` });

module.exports = {
  favicon,
  VAULT_ICON: shield,
  LOGIN_ICON: svg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#175ddc"/><path fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M20 15h14v22H20zM20 26h-8m8 0h4m-2-5 3 5-3 5"/></svg>',
  ),
  COPY_ICON: action('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  USER_ICON: action('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
  CLOCK_ICON: action('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>'),
  NOTE_ICON: action('<path d="M6 3h9l4 4v14H6z"/><path d="M9 10h6M9 14h6"/>'),
  EYE_ICON: action('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  EYE_OFF_ICON: action('<path d="M4 4l16 16"/><path d="M9.5 6.4A9.9 9.9 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.2 8.1A16.6 16.6 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 3.4-.6"/>'),
  LOCK_ICON: action('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  UNLOCK_ICON: action('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'),
  REFRESH_ICON: action('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>'),
  KEY_ICON: action('<circle cx="8" cy="14" r="4"/><path d="M11 12 20 4M17 4h3v3"/>'),
  WARNING_ICON: action('<path d="M12 3l9 16H3z"/><path d="M12 9v5M12 17v.5"/>'),
};
