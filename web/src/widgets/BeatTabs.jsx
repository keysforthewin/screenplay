import { useNavigate } from 'react-router-dom';

// Per-beat section switcher shown under the title on the Story (/beat),
// Dialogue (/dialog) and Prompts (/prompts) pages.
// `active` is one of 'writing' | 'dialog' | 'prompts' (keys are stable; only the
// labels changed). Styled as a segmented control so it reads as a page-level
// switch, distinct from the inner content `.tab-nav`.
const SECTIONS = [
  { key: 'writing', label: 'Story', base: '/beat' },
  { key: 'dialog', label: 'Dialogue', base: '/dialog' },
  { key: 'prompts', label: 'Prompts', base: '/prompts' },
];

export function BeatTabs({ order, active }) {
  const navigate = useNavigate();
  return (
    <div className="beat-section-tabs" role="tablist" aria-label="Beat sections">
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          type="button"
          role="tab"
          aria-selected={active === s.key}
          className={`beat-section-tab${active === s.key ? ' is-active' : ''}`}
          onClick={() => {
            if (active !== s.key) navigate(`${s.base}/${order}`);
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
