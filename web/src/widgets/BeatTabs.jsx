// The ONE row of tabs every beat page shows under its title:
//   Story | Dialogue | Sets | Characters | Critique | Coverage | Scenes
// All seven are panels of the one beat page (routes/Beat.jsx), which stays
// mounted while the tab changes. Dialogue and Scenes keep their own URLs
// (/dialog/:order, /scenes/:order); the others are addressed by URL hash
// (/beat/:order#sets). `active` is one of the keys below; a click hands the
// key to `onSelect`.
export const BEAT_TABS = [
  { key: 'story', label: 'Story', base: '/beat' },
  { key: 'dialog', label: 'Dialogue', base: '/dialog' },
  { key: 'sets', label: 'Sets', base: '/beat', hash: 'sets' },
  { key: 'characters', label: 'Characters', base: '/beat', hash: 'characters' },
  { key: 'critique', label: 'Critique', base: '/beat', hash: 'critique' },
  { key: 'coverage', label: 'Coverage', base: '/beat', hash: 'coverage' },
  { key: 'scenes', label: 'Scenes', base: '/scenes' },
];

// The panels living on /beat/:order, in tab order (the first is the hash-less one).
export const STORY_PANEL_KEYS = BEAT_TABS.filter((t) => t.base === '/beat').map((t) => t.key);

export function beatTabBase(key) {
  return (BEAT_TABS.find((x) => x.key === key) || BEAT_TABS[0]).base;
}

export function beatTabPath(key, order) {
  const t = BEAT_TABS.find((x) => x.key === key) || BEAT_TABS[0];
  return `${t.base}/${order}${t.hash ? `#${t.hash}` : ''}`;
}

// The tab a beat URL addresses: …/dialog/3 → dialog, …/scenes/3 → scenes,
// …/beat/3#sets → sets, anything else → story.
export function beatTabFromLocation({ pathname = '', hash = '' } = {}) {
  if (/\/dialog\/[^/]+\/?$/.test(pathname)) return 'dialog';
  if (/\/scenes\/[^/]+\/?$/.test(pathname)) return 'scenes';
  const h = hash.replace(/^#/, '');
  return STORY_PANEL_KEYS.includes(h) ? h : STORY_PANEL_KEYS[0];
}

export function BeatTabs({ active, onSelect }) {
  return (
    <div className="beat-section-tabs" role="tablist" aria-label="Beat sections">
      {BEAT_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          className={`beat-section-tab${active === t.key ? ' is-active' : ''}`}
          onClick={() => {
            if (active !== t.key) onSelect(t.key);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
