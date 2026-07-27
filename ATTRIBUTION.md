# Attribution

Outside work this project has learned from, and where it shows up in the code.

## seedance-2.0 — Emily (`@iamemily2050`)

- **Repository:** <https://github.com/Emily2040/seedance-2.0>
- **Author:** Emily — GitHub [@Emily2040](https://github.com/Emily2040), credited in the
  repo as `Iamemily2050 (@iamemily2050)`
- **License:** MIT
- **Version consulted:** 6.6.0 (reviewed 2026-07-27)

`seedance-2.0` is an agent skill pack for ByteDance's Seedance 2.0 video model — a
routing skill, 28 sub-skills, and 58 reference documents, with Python validators and
eval fixtures behind them. It is a genuinely impressive piece of research: the craft
layer is distilled from official documentation, professional filmmaking practice, and
field reports from prompting communities across five languages, and it is careful
throughout to label what is verified, what is practitioner-reported, and what is a
heuristic to test. That discipline is rarer than it should be, and it is what made the
material trustworthy enough to build on.

We do not use Seedance — this project renders through fal.ai (Kling and others) from a
generated start frame — so none of the platform-specific material applies here. What we
took was the craft reasoning underneath it, and we are grateful for it.

### What we adopted, and where it lives

| Idea | Source in that repo | Where it landed here |
|---|---|---|
| Anti-slop lexicon; the "camera, microphone, light meter, or stopwatch" visibility test | `references/anti-slop-lexicon.md`, `references/vocab/en.md`, `skills/seedance-antislop` | `ANTI_SLOP_RULES` in `src/web/storyboardConstraints.js` |
| "There is no NOT" — negation summons what it forbids | `references/model-mechanics.md` (mechanism 3) | the negation clause of `ANTI_SLOP_RULES` |
| Detail capacity scales with screen area | `references/model-mechanics.md` (mechanism 7), `references/cinematography-shot-language.md` | `SHOT_SIZE_FIDELITY_RULES` |
| The allocation model — identity, motion, and density compete for one budget | `references/allocation-model.md` | `primary_spend` on each planned shot; `SHOT_SIZE_FIDELITY_RULES` |
| Ending profiles; "the error is unmatched motion, not motion" | `references/cinematography-shot-language.md` | `ENDING_PROFILE_RULES` |
| Time as a trajectory prior — one cause with visible consequences beats a list | `references/model-mechanics.md` (mechanism 4), `skills/seedance-motion` | the cause-and-consequence rule in `VIDEO_PROMPT_RULES` |
| Three-tier action hierarchy for multi-person shots | `skills/seedance-characters` | the ensemble-discipline block of `PERFORMANCE_RULES` |
| Emotion is not directable — convert feeling into visible behavior | `references/directing-engine.md` (Step 4) | `PERFORMANCE_RULES`; the dialogue system prompt |
| The Director's Read: function, turn, POV, power, subtext → one intention | `references/directing-engine.md` (Steps 1–2) | `intention` and `turn` on the scene bible; the Pass-1 planner prompt |
| `felt_intent` per clip — what the viewer should feel or notice | `references/prompt-compiler.md`, `skills/seedance-sequence` | `felt_intent` on each planned shot |
| The Director's Voice held across a whole project | `references/directing-engine.md` (Steps 6, 8) | `plots.directorial_voice`, inherited by scene bibles, storyboard prompts, and dialogue |
| Known-fragile areas of generation | `references/failure-atlas.md`, `references/field-observed-tips.md`, `skills/seedance-troubleshoot` | `FRAGILITY_RULES`; the `fragility` critique lens in `src/web/storyboardCritique.js` |
| Objective / obstacle / tactic; subtext through contradiction | `references/directing-engine.md` (Step 4) | the `plan` field and system prompt in `src/web/dialogGenerate.js`; the rubric in `src/web/dialogCritique.js` |

### What we deliberately did not take

Noted so the divergence is a decision on record rather than an oversight:

- **Everything Seedance-surface-specific** — `@Image1` reference-tag syntax, `Shot 1:/2:/3:`
  multi-shot grammar, surface matrices, pricing, model IDs. We render one shot per row
  through a different provider.
- **The entire audio and lip-sync branch.** That repo wants dialogue quoted inside the
  prompt so the model synthesizes voice and lip-sync. We record real voices and lip-sync
  in post, so words must never enter a prompt — the opposite rule. See `formatDialogLines`
  in `src/web/storyboardGenerate.js`.
- **Multilingual vocab, IP/filter gating, and the delivery/QC/ACES/subtitle layer** — good
  material, not our problem yet.
- **The sequence-state JSON schemas and Project State Capsule.** Our MongoDB state and
  collaborative editor already hold this, with live multi-user editing on top.

Ideas are not copyrightable and no text was copied; the table above is a record of
intellectual debt, not a license obligation. It is here because the work deserves the
credit.
