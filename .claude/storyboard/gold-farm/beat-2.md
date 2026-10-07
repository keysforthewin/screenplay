# Gold Farm — beat 2 "Cold Open — The Movie Theater": storyboard notes

Beat id `69f2b38b958d920aa1c0b296`. Read this before planning or re-rendering anything in this beat (storyboard skill, step 1).

## Direction checklist

| Direction in the beat text | Cut | Status |
|---|---|---|
| CHAINED from Beat#1 — opens on the sky that held the crawl, first stars | (dropped) | The user cut the starfield clip and starts on the rise (2026-10-05). |
| SUPER: OTTAWA, CANADA. 1986… | — | Added in post. |
| SLOW MOTION. A sphere climbs into the bottom of frame | 1.1 (kf 1.0–5.0) | planned v4 |
| It slows. It hangs among the first stars | 1.1 (kf 5.0 = 6.0) | A visible hang: two keyframes at the same position, 1 s apart. |
| A horizontal anamorphic flare slides across the top of frame | — | Left out (a flare word in a prompt gets drawn as an object; add in post if wanted). |
| It begins to descend. The camera tilts down with it — one continuous move | 1.1 (kf 6.0 → 11.0) | planned v4, mid-tilt keyframe at 8.5 |
| Marquee and roofline enter the bottom of frame behind it | 1.1 (kf 8.5 → 11.0) | planned v4 |
| ZOOMS OUT / PULLS BACK / focus racks: the scale collapses | 1.1 (kf 11.0 → 16.0) | Locked-off low shot of the fall; the scale reads as the sack nears the lens (C3). |
| Still slow motion… lands on the instep of the sneaker | 1.1 (kf 16.0 → 16.5) | planned v4 |
| Normal speed. On the landing | 1.1 (kf 16.0 → 16.5) | The landing stretch is 8 frames for 0.11 H: the ramp is the keyframe spacing (C5, now in the plan, not post). |
| The sneaker flicks the hacky sack up again | 1.1 (kf 16.5 → 17.0) | Up and out of the top of frame (C6); exit keyframe at 17.0 so the hand cannot pick it off the shoe. |
| A small hand with a black digital watch snatches it out of the air | 1.1 (kf 17.0 → 18.0 → end 18.5) | The hand comes in and waits while the sack is out of frame, then it drops into the hand (C6, C7). |
| The camera rises from the asphalt… to YOUNG KEYS at the rear bumper | 1.2 | A cut to a medium-wide of Keys playing hacky sack (the user's call, C10). Frames and clip carried over from the old 1.7. |
| Opening montage — parking lot, ticket booth, lobby, auditorium… | scenes 2+ | not planned yet (one scene at a time) |

## Scene 1: the hacky sack — status: v4 keyframe plan 2026-10-06 (replaces the seven chained cuts v3)

Camera: straight up for the rise, one continuous tilt down to the low lot view, then locked off thirty centimetres above the asphalt. Look: 35mm, naturalistic dusk, slightly underexposed, fine grain, no lettering on any sign.

**Why one cut, not two.** The page describes ONE unbroken take from the sky to the hand, and the whole thing fits in 18.5 s — under the keyframe model's 20 s line, so no `long_clip`. One cut means no seam to match and one timeline for the speed. A two-cut version (sky+tilt / locked-off fall) would only buy a cheaper re-roll of one half; the cost is that a failed take re-renders the whole 18.5 s. A 30 s long_clip was not needed: the old chain ran ~26 s mostly because the first/last-frame model eased into every seam; with keyframes the rise is 4 s, the hang 1 s, the tilt 5 s, the fall 5.3 s, the kick-and-catch 2.2 s.

#### 1.1 The hacky sack — sky to hand (`6ac5bbdf19b9deae7d355ff2`), 18.5 s, keyframed, no long_clip
- Opens on: K1, the empty cobalt sky (old image reused). Ends on: K7B, the fingers closed around the sack (old image reused).
- Must happen: speck rises in slow motion and hangs; the camera tilts down with it to the theatre; it falls toward the low lens and becomes a hacky sack; the foot is planted before it lands; it lands on the instep at normal speed; the foot flicks it up and OUT of the top of frame; the hand comes in and waits; it drops back into the hand and the fingers snap shut.
- Moving object: the hacky sack. Rise 0.1125 H/s constant (slow motion); hang 0 H/s; descent with the tilt (dead centre, the world moves); slow-motion fall on screen ≈ 0.045–0.06 H/s while it grows speck → marble → plum; landing 0.11 H in 8 frames ≈ 0.33 H/s (the ramp); kick ≥ 1.1 H/s up and out; drop back ≈ 2 H/s.
- Camera: straight up (0–6 s), one smooth tilt down at a constant rate (6–11 s), locked off (11–18.5 s).
- Speed: slow motion until the landing, normal from the landing on — made by the keyframe spacing, no post retime.
- Must not: decoration on the sphere (metal, hull, glow, ship), a string or cord above the sack, a lone shoe, the hand picking the sack off the shoe, the sack hanging at the top of frame, the camera drifting after 11 s, the theatre rebuilt between keyframes, the sack changing size while it is in the air near the lens.

**Keyframe table** (H = frame heights from the bottom; grid = the 8-frame slot the renderer snaps to; times are the stored `at_seconds`):

| time (grid) | what is where | speed from the previous row | strength | image |
|---|---|---|---|---|
| 0.0 start | empty deep-cobalt sky, a few faint stars, no object | — | — | K1 reused (`6ac537e15656ae61ef7aeeeb`) |
| 1.0 (24) | speck 1/80 W wide, centre column, 0.05 H — just inside the bottom edge | entering; slow motion | 0.5 | composite (`6ac5bc3719b9deae7d35604c`): K2's sky, its speck moved down |
| 3.0 (72) | speck at 0.275 H, centre column | 0.1125 H/s constant rise | 0.5 | composite (`6ac5bc7419b9deae7d356056`), same |
| 5.0 (120) | speck at 0.50 H, dead centre | 0.1125 H/s constant rise | default | K2 reused (`6ac5382fb171508c8f9d854a`) |
| 6.0 (144) | speck at 0.50 H, dead centre — the hang | 0 H/s (hang) | default | K2 again (same image) |
| 8.5 (200) | speck dead centre; the tilt is half done: the lower third of frame grades to amber, the top edge of the bulb-framed marquee lightbox is just inside the bottom edge, soft | tilt at a constant rate, speck held centre | 0.5 | composite (`6ac5bdd619b9deae7d356075`): K2's sky over the top 288 rows of K3 shifted down 480 px (marquee bulbs at the bottom edge), speck re-pasted at centre. The Nano Banana edit put the whole marquee in frame, centred and large — wrong geometry for a pure tilt. |
| 11.0 (264) | the low lot view: van corner far left, theatre, marquee, lamps; the dot at 0.75 H, just right of centre | tilt at the same rate, settles | default | K3 reused (`6ac53845c0359e474b32e18d`) |
| 13.5 (320) | locked off; the sack at 0.63 H (px 760,290), just right of centre, a marble-sized (28 px) ball with red and navy panels | 0.05 H/s on screen, slow motion, growing | 0.5 | composite (`6ac5bdd619b9deae7d35607b`): K3 with the dot painted out + the K5 sack scaled to 28 px. The edit rendered it plum-sized and beside the marquee. |
| 16.0 (384) | the sack at 0.50 H (px 915,380), plum-sized (186×146 px), in the right third above the boy's planted right foot — a hand's width above the shoe | 0.05 H/s, slow motion; the foot stepped in during this stretch | 0.5 | composite (`6ac5bdd619b9deae7d356083`): K5E (foot, no sack) + the K5 sack cut with an elliptical feathered mask, 95 px higher. The edit REBUILT the place (another cinema, a white van). |
| 16.5 (392) | K5: the sack resting on the instep of the planted sneaker, 0.39 H, slightly flattened, dust | 0.11 H in 8 frames ≈ 0.33 H/s — the ramp to normal speed | default | K5 reused (`6ac59030f5c6f2762187ca2f`) |
| 17.0 (408) | the sack half out of the TOP edge at 0.53 W (its lower half visible), the foot planted and empty, no hand | ≥ 1.1 H/s up (16 frames for the rest on the shoe + 0.75 H) | 0.5 | composite (`6ac5bc7419b9deae7d35605c`): K5E + the sack cut from K6a |
| 18.0 (432) | K5H: the hand with the black digital watch reaching down beside the shin, open, fingers spread; nothing in the air | the sack is out of frame above (≈ 1.2 s off screen) | default | K5H reused (`6ac5984747211733bfe150bf`) |
| 18.5 end (443) | K7B: the fingers closed around the sack, hand where it was | the sack re-enters at the top and drops 0.5 H in ≈ 6 frames ≈ 2 H/s, the hand snaps shut | — | K7B reused (`6ac5985f47211733bfe150d0`) |

Frame gate 2026-10-06 (`qc.py frames`): every edit keeps its picture at ≥ 0.886 except 8.5→11 s (0.358 — the tilt itself: the whole frame changes between the sky and the lot view, by design) and 13.5→16 s (0.674 — the foot enters and the sack grows; the two bases, K3 and K5E, are old-chain siblings with some drift). Sheet shown to the user; waiting for the OK before any video.

**Renderer check**: the Admin default video renderer was `ltx2-5-flf2v` (first/last frame, ignores keyframes) when this plan was made — it must be `ltx-2.5-keyframes` before `render_videos`, or every keyframe will be "missed".

**Take A** (2026-10-06, keyframe model, guides as planned at 0.5 on the composites, 0.7 elsewhere; `qc.py clips` hit every keyframe ≥ 0.74 — but the hits measure the static background, not the ball): the rise ran in 2.5 s then hung 4.5 s; the tilt waited until ~8 s and ran twice as fast, then held; the fall, landing and kick happened at 13.7–14.7 s instead of 16–17 s, the foot stood empty at 16.5 s (K5 at 0.7 was ignored), the hand entered by 16 s, and the sack came down past the hand and jumped into it at 17.6 s. Lesson: 0.5 is too soft for a small moving object against a big static frame — the model keeps the frame and invents the object's timing. → **Take B**: rise/mid-tilt/mid-fall composites at 0.75, above-foot / on-shoe / exit at 0.8 (the cap). Take A kept as `takeA_1_1.mp4` (not stored).

**Take B** (strengths 0.75/0.8): the back half now follows the plan — sack a hand above the shoe at 16 s, lands 16.5, kicked out ~16.7, hand in, catch at ~17.4 s (0.6 s early, then a hold). Still wrong: the rise reached the centre by 2.7 s (planned 5), the whole tilt ran 8.3–9.7 s (planned 6–11) and held, and between 12 and 15 s the model dropped the sack onto the ASPHALT and hopped it onto the shoe — the marble-in-the-sky guide at 13.5 was ignored. Lesson: a 2.5 s gap between guides is where the model invents; a guide holding a tiny object does not hold its timing. → **Take C**: five more composite keyframes — 2.0 and 4.0 s (speck at 0.16 / 0.39 H, `6ac5c42019b9deae7d3560c6`, `6ac5c42019b9deae7d3560cd`), 9.5 s (three-quarter tilt: K3 shifted down 240 px over K2's sky, `6ac5c42119b9deae7d3560d4`), 12.5 s (K3's dot moved to 0.71 H, `6ac5c42119b9deae7d3560dc`), 15.0 s (foot planted, sack at two-thirds size above and left of the shoe, `6ac5c42219b9deae7d3560e6`) — so no gap is over 1.5 s, and every composite at the 0.8 cap. Take B kept as `takeB_1_1.mp4` (not stored).

Sub-second pairs on purpose: 16.0/16.5 (8 frames — the landing is the normal-speed ramp) and 16.5/17.0 (16 frames — the kick). `sb.py verify` flags both; they are the plan. Everything else is ≥ 1 s apart.

#### 1.2 The reveal (`6ac5bbe519b9deae7d355ffe`), 6 s
- A cut to a medium-wide at the Aerostar's rear bumper (camera 1 m high, 2.5 m away). It is Young Keys, playing hacky sack by himself. Frames (`6ac58f8cc07b23129b80e501` → `6ac590c244001f68b04ce64c`) and the clip copied over from the old 1.7 unchanged.

## Corrections

Each entry: what the output did → what changed → what the story should say (pending | applied | not needed).

- **C1** 2026-10-05 · 1.1–1.3 · The text's "dark metal with a hot rim of light… a sphere ship" was drawn literally: a decorated ship that morphed into the sack. → The frames describe only an undecorated dark sphere. Distance and light make it read as a ship. → Story: describe what the camera sees and name the misreading as the audience's: "Backlit by the last amber at the horizon it is only a dark, featureless sphere with a hot rim of light along one edge — at this height it could be anything; it could be a ship." (pending)
- **C2** 2026-10-05 · 1.1 · The starfield opening was cut; the scene starts on the rise. → Story: none in this beat (it is beat 1's handoff). Check beat 1's ending when it is storyboarded. (not needed)
- **C3** 2026-10-05 · 1.3 · ZOOM OUT + PULL BACK + rack focus "all at once" cannot be rendered between two keyframes; the attempts morphed. → The tilt locks off on the theatre and the sack falls toward a low lens; the scale reads as it nears. → Story: "The camera settles, locked off, low on the asphalt. The sphere keeps falling toward the lens, and as it nears the scale collapses: the marquee is a hundred yards off; the sphere is three feet from the lens and the size of a plum — a HACKY SACK…" (pending)
- **C4** 2026-10-06 · 1.3 · "lands on the instep of a white canvas low-top sneaker" rendered an empty shoe lying in the lot. → The keyframe states the foot planted, the sock, the jeans hem and the shin out of frame. → Story: "…lands on the instep of a boy's sneaker — his foot planted on the asphalt, white canvas low-top, white tube sock with two red bands, the frayed hem of his jeans, the rest of him out of frame." (pending)
- **C5** 2026-10-06 · 1.3 · "Normal speed. On the landing" was lost: the chain rule made every clip slow motion. → Speed ramp in post as the foot enters. → Story: "The slow motion holds until the foot comes into frame; from there everything runs at normal speed." (pending)
- **C6** 2026-10-06 · 1.4–1.6 · "flicks the hacky sack up… snatches it out of the air" made the hand pick the sack off the shoe, then a sack that slowed and hung at the top of the frame. → The kick sends it up and out of the top of the frame; the hand comes in and waits while it is out of frame; it drops back into the hand. → Story: "The sneaker flicks the hacky sack straight up and out of the top of frame. A small hand with a black digital watch reaches down into frame and waits, open. The hacky sack drops back into it and the fingers snap shut." (pending)
- **C7** 2026-10-06 · 1.4–1.6 · The ball slowed or hung at the ends of clips ("a broken clip"). → User rule: anything in flight moves at one constant speed, with turnarounds off screen. Measured with `qc.py track` and retimed. → Story: "It goes up and comes back down at the same quick speed." Open question for the user: the text's apex hang in the sky ("It slows. It hangs among the first stars") contradicts the rule. Keep it as a deliberate beat, or make the turn happen off the top of frame? (pending: ask)
- **C8** 2026-10-06 · 1.6 · The sack was invented mid-clip at 3× size and unrolled into a sock. → It starts in the start keyframe, entering at the top edge (a composite, after two keyframe renders rebuilt the whole place). Not a story change. (not needed)
- **C9** 2026-10-06 · 1.6 · The words "crocheted… yarn… drops into the frame" grew a cord above the falling sack. → The video prompt calls it "a small, firm, round beanbag ball… a loose ball in free fall with nothing attached to it". Not a story change; the stills keep "crocheted". (not needed)
- **C10** 2026-10-06 · 1.7 · "The camera rises from the asphalt up the tube socks… to YOUNG KEYS" became a cut to a medium-wide, the user's call. → Story: "Cut to: the rear bumper of the Aerostar, medium-wide. It is YOUNG KEYS — striped red-and-navy T-shirt, black digital watch — playing hacky sack by himself." (pending)

## Story changes to propose

Collected from the corrections above. Offer them when the user accepts scene 1, or when the beat is done; apply nothing without a yes. The screenplay MCP server has no beat-text tool, so the user pastes the new text into the Story tab or gives it to the bot.

1. "Backlit by the last amber… it reads as dark metal with a hot rim of light along one edge — a sphere ship, a long way up, rotating slowly on its axis." → C1 wording.
2. "The lens ZOOMS OUT as the camera PULLS BACK and the focus racks, all at once. The scale collapses." → C3 wording.
3. "…lands on the instep of a white canvas low-top sneaker — white laces, white tube sock with two red bands at the top." → C4 wording.
4. "Normal speed. On the landing, …" → C5 wording (the music cue stays on the landing).
5. "The sneaker flicks the hacky sack up again — … A small hand with a black digital watch on the wrist snatches it out of the air." → C6 + C7 wording.
6. "The camera rises from the asphalt up the tube socks and faded jeans to YOUNG KEYS at the rear bumper…" → C10 wording.
7. Question: keep "It slows. It hangs among the first stars"? (C7)
