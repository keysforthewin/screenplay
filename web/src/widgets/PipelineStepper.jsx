// Where this beat is in the script → prompts → clips → beat video pipeline.
// Read-only strip derived from the storyboard rows and the beat doc; the
// buttons that advance each stage live in the toolbar.
export function PipelineStepper({ shots, beat, dialogs }) {
  const n = shots.length;
  const withPrompt = shots.filter((s) => (s.text_prompt || '').trim()).length;
  const withClip = shots.filter((s) => s.video_file_id).length;
  const withStill = shots.filter((s) => s.frames?.[0]?.image_id).length;
  const lines = Array.isArray(dialogs) ? dialogs.filter((d) => (d.body || '').trim()) : [];
  const recorded = lines.filter((d) => d.audio_file_id).length;
  const hasBeatVideo = Boolean(beat?.video_file_id);

  const steps = [
    {
      key: 'dialog',
      label: 'Dialogue',
      state: lines.length === 0 ? 'todo' : recorded === lines.length ? 'done' : 'partial',
      detail: lines.length === 0 ? 'no lines' : `${recorded}/${lines.length} recorded`,
    },
    {
      key: 'plan',
      label: 'Shot prompts',
      state: n === 0 ? 'todo' : withPrompt === n ? 'done' : 'partial',
      detail: n === 0 ? 'not planned' : `${withPrompt}/${n} shots`,
    },
    {
      key: 'clips',
      label: 'Clips',
      state: n === 0 || withClip === 0 ? 'todo' : withClip === n ? 'done' : 'partial',
      detail: n === 0 ? '—' : `${withClip}/${n}${withStill ? ` · ${withStill} stills` : ''}`,
    },
    {
      key: 'beat',
      label: 'Beat video',
      state: hasBeatVideo ? 'done' : 'todo',
      detail: hasBeatVideo ? 'assembled' : 'not assembled',
    },
  ];

  return (
    <div className="pipeline-stepper" aria-label="Beat pipeline">
      {steps.map((s, i) => (
        <div key={s.key} className={`pipeline-step state-${s.state}`}>
          <span className="pipeline-step-index">{i + 1}</span>
          <span className="pipeline-step-label">{s.label}</span>
          <span className="pipeline-step-detail">{s.detail}</span>
        </div>
      ))}
    </div>
  );
}
