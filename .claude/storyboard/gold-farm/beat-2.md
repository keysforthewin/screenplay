# Gold Farm — beat 2 "Cold Open — The Movie Theater": storyboard notes

Beat id `69f2b38b958d920aa1c0b296`. Read this before planning or re-rendering anything in this beat (storyboard skill, step 1).

## Direction checklist

| Direction in the beat text | Cut | Status |
|---|---|---|
| CHAINED from Beat#1 — opens on the sky that held the crawl, first stars | (dropped) | The user cut the starfield clip and starts on the rise (2026-10-05). |
| SUPER: OTTAWA, CANADA. 1986… | — | Added in post. |
| SLOW MOTION. A sphere climbs into the bottom of frame | 1.1 (kf 1.0 → 3.5) | v5: entry + top only; the model runs the rise at its own pace (~2.5 s in takes A and B), so the plan gives it 2.5 s |
| It slows. It hangs among the first stars | 1.1 (kf 3.5 = 4.5) | v5: the hang, the same picture twice |
| A horizontal anamorphic flare slides across the top of frame | — | Left out (a flare word in a prompt gets drawn as an object; add in post if wanted). |
| It begins to descend. The camera tilts down with it — one continuous move | 1.1 (kf 4.5 → 7.5) | v5: one mid-tilt composite at 6.0 |
| Marquee and roofline enter the bottom of frame behind it | 1.1 (kf 6.0 → 7.5) | v5 |
| ZOOMS OUT / PULLS BACK / focus racks: the scale collapses | 1.1 (kf 7.5 → 10.5) | v5: the transformation, four steps of one sprite on one plate (C3, C11) |
| Still slow motion… lands on the instep of the sneaker | 1.1 (kf 10.5 → end 11.0) | v5: 1.1 ends on the landing |
| Normal speed. On the landing | cut 1.1 → 1.2 | v5: the speed change is the cut (C12) |
| The sneaker flicks the hacky sack up again | 1.2 (start → kf 1.0) | v5: 1.2 opens on the sack just flicked off his instep (match on action) |
| A small hand with a black digital watch snatches it out of the air | 1.2 (kf 1.0) | v5: the catch keyframe |
| The camera rises from the asphalt… to YOUNG KEYS at the rear bumper | 1.2 | Medium-wide of Keys (C10); after the catch he keeps playing (toss, knee) to the end frame |
| Opening montage — parking lot, ticket booth, lobby, auditorium… | scenes 2+ | not planned yet (one scene at a time) |

## Scene 1: the hacky sack — status: v7 one size from the first frame 2026-10-07 (replaces v6)

**The user's verdict on v6 (2026-10-07):** "a little better". But 1.1's end should be 1.2's start: 1.1 opens on a speck, and "I wanted it to be the same size at all times. The size it has when it hits the foot should be the same as in the start frame. It becomes more visible as the camera follows it down to the ground, where it is now being lit by the lighting on the ground. You can see that it's a hacky sack, and then it hits the foot. It should go right to 1.3, and there's no reason to change the speed at all in cut 1.2."

**v7:**
- The ball is 175 px from its first frame.
- 1.1 and 1.2 are chained at the hang: one picture, `comp/v7_hang`.
- The light on the ball rises as it comes down: 24 % → 27 % → 40 % → 85 % → 95 % → K5.
- 1.2 is one steady tilt, 0 → 768 px over 5 s (154 px/s), with the ball drifting right 32 px/s. The camera settles, the ball keeps falling at about 120 px/s, the foot steps in over about 1 s, and the cut ends on contact with no hold, then cuts to 1.3.
- The sky is K1 throughout. K1 and K2 are the same picture: mean difference 2.7, zero shift.
- Builder: `comp/v7.py` (scratchpad).

#### 1.1 The sphere in the sky — climbs and hangs (`6ac5bbdf19b9deae7d355ff2`), 4.5 s, locked off
| time | why | what | strength |
|---|---|---|---|
| 0.0 start | start | K1, the empty sky | — |
| 1.0 | entry | ball 175 px at (720,735), a third in view at the bottom edge, dark with an amber rim | 0.8 |
| 3.0 | top | ball at (720,330) | 0.8 |
| 4.5 end | hang (the same picture) = 1.2 start | the same | — |

#### 1.2 The camera follows it down; lit in the lot, it lands on a foot (`6ac6e7d543587560b05c04ca`), 6.5 s
| time | why | what | ball light | strength |
|---|---|---|---|---|
| 0.0 start | = 1.1 end | the hang | 24 %, rim | — |
| 1.0 | pace (v6A sat still for 1 s without it) | window 154; ball (752,324) | 27 %, rim | 0.8 |
| 2.5 | mid-move | window 384: van, roofline, marquee rising; ball (800,315) | 40 % | 0.8 |
| 5.0 | move end; "you can see it's a hacky sack" | K5E-empty; ball (880,300) at the marquee's left end | 85 % | 0.8 |
| 6.0 | event: the foot is in | K5E; ball (902,420) | 95 % | 0.8 |
| 6.5 end | contact, CUT | K5 (copy) | full | — |

1.3 is unchanged (v6 take B, trimmed to 1.5 s).

**v7 take A (stored, 2026-10-07).**
- **1.1:** every keyframe ≥ 0.98. The ball enters at 0.75 s, reaches the top about 2.6 s, and hangs to 4.7 s. The seam to 1.2 scores 0.98.
- **1.2:** every keyframe ≥ 0.83. The camera moves from frame 0, so the gate's "nothing moves until frame 24" is a false alarm on the even sky.
- **1.2 speed, measured** with scratchpad `comp/track.py` (screen + camera = world): about 130 → 175 (1–2.5 s) → 115 (4.25–5.25 s) → 130 px/s after the stop. The renderer eased the tilt: 132 → 200 px/s, then a settle from 3.5 to 5.0 s. Over 4.0–4.75 s the ball hardly moves on screen while the background settles, a slight float in front of the marquee.
- **1.2 foot:** comes down from the top right from 5.4 s to 5.9 s and brushes past the ball. Contact at frame 148.
- **Post:** keep frames 0–148 (6.2 s), cut on contact. Raw: `takes/v7A_1_2_raw.mp4`.
- **Next lever if the speed still shows:** a pace keyframe at 4.0 (window 614) to stop the early settle, and the ball 30–60 px lower on screen at 5.0 so it keeps falling as the camera stops.
- Preview: scratchpad `scene1_v7.mp4` (12.4 s).

### v6 (superseded 2026-10-07) — kept for its take notes

**The user's verdict on v5 take B (2026-10-07).** The drop works now. But the ball rises and falls, and then "it looks like it's going from far away to close up… rushing towards the camera. Boom, there's a hacky sack in front, on top of a foot". The old 1.2 ("then it just does a really bad imitation of someone playing hacky sack") is also out. The goal is the Flight of the Navigator opening: a frisbee reads as a spaceship until a dog jumps in and catches it. Here the hacky sack falls from the sky, and the moment it hits the foot you realise it is a hacky sack. The user asked about tilt-shift. Tilt-shift makes a big thing look small, which is the opposite of what we want. The levers that make a small thing look big are a long lens, a constant size on screen, backlight, and no scale cue until the reveal.

**v6: three cuts.**
- 1.1 is the wide: the speck rises and hangs. That part was "okay", so it is v5 take B trimmed, with no re-render.
- 1.2 (new) is the long lens. The sphere is already its final size, about 175 px, a silhouette with a hot amber rim. It holds that size while the camera follows it down, passes in front of the lit marquee as big as the marquee, then the camera stops, the foot steps in, and it lands. The scale changes on the cut, never inside a shot.
- 1.3 is normal speed: the flick and the catch, 2 s, and nothing more. The page's next paragraph has Keys look at the marquee and pocket it, which belongs to the montage.

#### v6 1.1 The speck in the sky — rise and hang, 4.5 s
Start K1 → kf 1.0 entry → kf 3.5 top → end 4.5 = the hang picture (copy of `6ac5bbfc19b9deae7d35600c`). The v5 keyframes from 4.5 on were deleted; their composites are the v5 table below. **Clip:** v5 take B frames 0–107 (the tilt starts moving at 4.2 s, so the cut lands on the first move of the descent). Stored as `ltx-2.5-keyframes post:v5B-trim(keep-0-107)`.

#### v6 1.2 Long lens — the ship comes down and lands on a foot, 6 s
- Built by scratchpad `comp/ship.py` (not kept; the recipe is below).
- **The sky** is K2 with its speck inpainted, magnified ×1.6 about the centre, so the cut reads as a new lens rather than a jump.
- **One panorama:** that sky over K5E-empty, with a 360-row blend.
- **One sprite at one width (175 px):** the v5 sack, darkened to 24 % brightness, with a hot amber rim on the edge facing the horizon glow (light from below, a little left). It drifts right 40 px/s, from (720,330) to (880,300).

| time | why | what is where | strength | image |
|---|---|---|---|---|
| 0.0 start | start (cut in on the descent) | long-lens sky; the sphere 175 px at (720,330), a silhouette with an amber rim | — | composite `v6_s0` |
| 2.0 | mid-move | the panorama window at 384: the van roof, the roofline and the marquee rising in at the bottom; the sphere at (800,315) | 0.8 | composite `v6_k2` |
| 4.0 | move end; the "ship" image | K5E-empty; the sphere at (880,300) as a black silhouette against the lit marquee, as big as it | 0.8 | composite `v6_k4` |
| 4.5 | event: the foot is in | K5E (foot planted); the sphere at (905,405) at 55 %, panels just readable | 0.8 | composite `v6_k45` |
| 5.0 | contact | K5: landed on the instep | default | copy of `6ac6de58136d57b176f090cc` |
| 6.0 end | hold (the reveal lands) | K5 again | — | same |

Must not happen: the sphere growing or shrinking before 4.5; the sky and the lot moving apart (a wipe, problem 26); the foot arriving before 4.0; the sack touching the asphalt.

#### 1.3 Normal speed — Keys flicks it up and snatches it (`6ac5bbe519b9deae7d355ffe`), 2 s (kept in v7)
Start: the flick (`6ac6e580aaaafb69c2a23573`, Nano Banana Pro edit of the old start). kf 1.0: the catch (`6ac6de2b136d57b176f090c2`). End 2.0: the same catch picture (a hold). The old 6.5 s version ended on a knee raise and kept him playing; that is cut.

**v6 takes (2026-10-07).**
- **1.2 take A (stored):** the descent holds one size, and the roofline and marquee rise behind it with no wipe. The foot comes DOWN from the top of frame in about 0.2 s (4.17 → 4.33 s) and the sack lands at 4.42, ahead of the 4.5 keyframe (scored 0.74). It is sudden, as planned, but fast for slow motion. If the user wants it gentler, move the 4.0 keyframe to 3.5 and add a mid-step foot keyframe. Static for the first second (nothing moves until frame 24). **Post:** keep frames 20–124 (4.38 s), so it is moving on the cut and holds 0.75 s after the landing. Raw: `takes/v6A_1_2_raw.mp4`.
- **1.3 take A:** garbled. The leg kicked high, the sack flew off behind his head and reappeared in his hand: the shortest-path fault with no picture of the arc's top. **Take B (stored):** added kf 0.5 at strength 0.75, the flick picture with the sack moved to chest height in front of the cinema (`comp/apex.py`; at first it was pasted on his striped shirt and vanished into the stripes, so it went off the body). Now the foot really flicks it at frame 2, it pops to shoulder height, and it lands in his right hand by frame 18. **Post:** keep frames 0–35 (1.5 s). Raw: `takes/v6B_1_3_raw.mp4`.
- Known: 1.3's lot (orange trees, a different facade) is not K5's lot. It has carried over since the C10 medium-wide.
- Scene preview: scratchpad `scene1_v6.mp4` (10.4 s), sent to the user.

### v5 (superseded 2026-10-07) — kept for its take notes

**The user's verdict on v4 take C (2026-10-07).** The start was fine and tracked the ball. There were too many keyframes, "placed randomly"; they belonged on the orb → hacky sack transition, to make it smooth and not confusing. The end was broken: the ball hit the ground, went full speed, then stopped. When the ball goes full speed the user expects to just see the kid playing normally, and a different cut is fine.

**What the take C sheet showed.** 17 keyframes in 18.5 s, spaced for coverage (no gap over 1.5 s), not for difficulty. 13.5 → 15 s switched the lot plate from K3 to K5E (pixel-aligned, but a darker cobalt sky and unlit wall lamps against a pale sky and lit lamps), brought the foot in and doubled the sack. That is three changes in one interval, exactly where the sack fell to the asphalt. The landing → kick → catch at "normal speed" was a spacing change inside one generation.

**v5: two cuts.** 1.1 is slow motion from the sky to the landing: 11 s, 8 keyframes, 4 of them (plus the end frame) spent on the transformation in its last 3.5 s. 1.2 is normal speed, Keys at the bumper: the flick, the catch, then he keeps playing. Built with the skill's "Where keyframes go" rules, which this verdict produced.

#### v5 1.1 The hacky sack — sky to the landing, 11 s
- Opens on K1, the empty sky. Ends on K5, the sack on the instep (a copy, `6ac6de58136d57b176f090cc`).
- **One plate after the tilt:** K5E (foot, no sack), rebuilt from the old 15.0 and 17.0 composites, and K5E-empty: K3 Poisson-blended into K5E's leg region (`cv2.seamlessClone`, region = the difference after a smooth colour-gain map). K3 and K5E are pixel-aligned. **One sprite:** the sack cut from the old 16.0 composite by its difference from K5E, scaled down (never up) and darkened at small sizes. Scripts: scratchpad `comp/k5e.py`, `empty_local2.py`, `empty_local3.py`, `fixtop.py`, `build.py` (not kept; the recipe is here).
- Must happen: the rise, the hang, the tilt with the speck dead centre, the dark ball growing into the sack in front of the theatre, the foot stepping in, the landing.
- Must not: the sack touching the asphalt; a second object (it is ONE ball scaled); the lot re-lit between keyframes; a hold or ease at the end.
- Speed: slow motion throughout. The approach grows ×1.75–1.9 per second (geometric), drifting 72–80 px/s right, then drops 70 px in 0.5 s onto the shoe.

| time | why | what is where | plate | strength | image |
|---|---|---|---|---|---|
| 0.0 start | start | empty cobalt sky | K1 | — | `6ac5bbfb19b9deae7d355fff` |
| 1.0 | entry | speck 12 px at 0.05 H, centre column | K1 + speck | 0.8 | `6ac5bc3719b9deae7d35604c` |
| 3.5 | top of the rise | speck dead centre | K2 | default | `6ac5bbfb19b9deae7d356006` |
| 4.5 | hold (the hang) | the same | K2 | default | `6ac5bbfc19b9deae7d35600c` |
| 6.0 | mid-move (tilt) | K2's sky over K5E-empty scrolled down 384 px: the van roof, the roofline and the marquee in the lower third; orb 16 px, dark, dead centre | K2 / K5E-empty | 0.8 | `6ac6df4f136d57b176f090d4` |
| 7.5 | move end + transformation 1 | K5E-empty; orb 24 px, dark, at centre (688,384), past the end of the roofline | K5E-empty | 0.8 | `6ac6df50136d57b176f090da` |
| 8.5 | event (foot steps in) + transformation 2 | K5E: foot planted; sack 42 px at 45 % brightness, (758,388) | K5E | 0.8 | `6ac6df50136d57b176f090e2` |
| 9.5 | transformation 3 | sack 76 px at 75 %, (835,402), panels readable | K5E | 0.8 | `6ac6df50136d57b176f090ea` |
| 10.5 | transformation 4 | sack 140 px, full colour, (905,430), a hand above the laces | K5E | 0.8 | `6ac6df50136d57b176f090f2` |
| 11.0 end | the landing | K5: the sack on the instep (915,499), dust haze | K5 (same family) | — | `6ac6de58136d57b176f090cc` |

**v5 take A** (2026-10-07): every keyframe hit (≥ 0.83). The transition worked: one ball growing from a dark dot into the sack in front of the theatre, the foot stepping in at 8 s, the landing on the instep, nothing on the asphalt. The tilt was a wipe: a hard edge swept up over a sky that did not move. The mid-tilt composite had laid K2's sky at its own position and slid the lot up under it, which is not a tilt. Fix: the mid-tilt frame is a window halfway down ONE tall panorama, K2's sky stacked above K5E-empty with a 360-row blend, so the stars and the cloud band move up and out (`6ac6e1b343587560b05c049b`). v4's tilt composites had the same fault. Take A kept locally as `takes/v5A_1_1.mp4`.
**v5 take B** (stored): the tilt is now a tilt (5.3–7.0 s), and the transition is as good as A's (foot at 8.1 s, landing 10.5 s). Clip gate: every keyframe ≥ 0.83; held from frame 257. **Post:** trimmed the tail to frames 0–258 (10.79 s), so the cut lands on the landing. Stored as `ltx-2.5-keyframes post:trim-tail-6f(keep-0-258)`; raw take kept as `takes/v5B_1_1_raw.mp4`. Re-apply after any re-render.

#### v5 1.2 Normal speed — flick, catch, play, 6.5 s
| time | why | what | image |
|---|---|---|---|
| 0.0 start | match on action (the cut on the landing) | Keys at the bumper, right foot lifted from the flick, the sack a hand above the toe, the watch hand open and coming forward | new Nano Banana Pro edit of the old start |
| 1.0 | event (the catch) | the sack closed in his right hand at waist height, looking down at it | copy of the old 1.2 start, `6ac6de2b136d57b176f090c2` |
| 6.5 end | end | right knee raised, the sack above it | old 1.2 end, `6ac5bc0219b9deae7d35603a` |

#### v4 (superseded 2026-10-07) — kept for its take notes

Camera: straight up for the rise, one continuous tilt down to the low lot view, then locked off thirty centimetres above the asphalt. Look: 35mm, naturalistic dusk, slightly underexposed, fine grain, no lettering on any sign.

**Why one cut, not two.** The page describes ONE unbroken take from the sky to the hand, and the whole thing fits in 18.5 s — under the keyframe model's 20 s line, so no `long_clip`. One cut means no seam to match and one timeline for the speed. A two-cut version (sky+tilt / locked-off fall) would only buy a cheaper re-roll of one half; the cost is that a failed take re-renders the whole 18.5 s. A 30 s long_clip was not needed: the old chain ran ~26 s mostly because the first/last-frame model eased into every seam; with keyframes the rise is 4 s, the hang 1 s, the tilt 5 s, the fall 5.3 s, the kick-and-catch 2.2 s.

#### v4 1.1 The hacky sack — sky to hand, 18.5 s
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

#### v4 1.2 The reveal, 6 s
- A cut to a medium-wide at the Aerostar's rear bumper (camera 1 m high, 2.5 m away). It is Young Keys, playing hacky sack by himself. Frames (`6ac58f8cc07b23129b80e501` → `6ac590c244001f68b04ce64c`) and the clip copied over from the old 1.7 unchanged.

## Corrections

Each entry: what the output did → what changed → what the story should say (pending | applied | not needed).

- **C1** 2026-10-05 · 1.1–1.3 · The text's "dark metal with a hot rim of light… a sphere ship" was drawn literally: a decorated ship that morphed into the sack. → The frames describe only an undecorated dark sphere. Distance and light make it read as a ship. → Story: describe what the camera sees and name the misreading as the audience's: "Backlit by the last amber at the horizon it is only a dark, featureless sphere with a hot rim of light along one edge — at this height it could be anything; it could be a ship." (pending)
- **C2** 2026-10-05 · 1.1 · The starfield opening was cut; the scene starts on the rise. → Story: none in this beat (it is beat 1's handoff). Check beat 1's ending when it is storyboarded. (not needed)
- **C3** (superseded by C13) 2026-10-05 · 1.3 · ZOOM OUT + PULL BACK + rack focus "all at once" cannot be rendered between two keyframes; the attempts morphed. → The tilt locks off on the theatre and the sack falls toward a low lens; the scale reads as it nears. → Story: "The camera settles, locked off, low on the asphalt. The sphere keeps falling toward the lens, and as it nears the scale collapses: the marquee is a hundred yards off; the sphere is three feet from the lens and the size of a plum — a HACKY SACK…" (pending)
- **C4** 2026-10-06 · 1.3 · "lands on the instep of a white canvas low-top sneaker" rendered an empty shoe lying in the lot. → The keyframe states the foot planted, the sock, the jeans hem and the shin out of frame. → Story: "…lands on the instep of a boy's sneaker — his foot planted on the asphalt, white canvas low-top, white tube sock with two red bands, the frayed hem of his jeans, the rest of him out of frame." (pending)
- **C5** (superseded by C12) 2026-10-06 · 1.3 · "Normal speed. On the landing" was lost: the chain rule made every clip slow motion. → Speed ramp in post as the foot enters. → Story: "The slow motion holds until the foot comes into frame; from there everything runs at normal speed." (pending)
- **C6** (superseded by C12) 2026-10-06 · 1.4–1.6 · "flicks the hacky sack up… snatches it out of the air" made the hand pick the sack off the shoe, then a sack that slowed and hung at the top of the frame. → The kick sends it up and out of the top of the frame; the hand comes in and waits while it is out of frame; it drops back into the hand. → Story: "The sneaker flicks the hacky sack straight up and out of the top of frame. A small hand with a black digital watch reaches down into frame and waits, open. The hacky sack drops back into it and the fingers snap shut." (pending)
- **C7** 2026-10-06 · 1.4–1.6 · The ball slowed or hung at the ends of clips ("a broken clip"). → User rule: anything in flight moves at one constant speed, with turnarounds off screen. Measured with `qc.py track` and retimed. → Story: "It goes up and comes back down at the same quick speed." Open question for the user: the text's apex hang in the sky ("It slows. It hangs among the first stars") contradicts the rule. Keep it as a deliberate beat, or make the turn happen off the top of frame? (pending: ask)
- **C8** 2026-10-06 · 1.6 · The sack was invented mid-clip at 3× size and unrolled into a sock. → It starts in the start keyframe, entering at the top edge (a composite, after two keyframe renders rebuilt the whole place). Not a story change. (not needed)
- **C9** 2026-10-06 · 1.6 · The words "crocheted… yarn… drops into the frame" grew a cord above the falling sack. → The video prompt calls it "a small, firm, round beanbag ball… a loose ball in free fall with nothing attached to it". Not a story change; the stills keep "crocheted". (not needed)
- **C10** (superseded by C12) 2026-10-06 · 1.7 · "The camera rises from the asphalt up the tube socks… to YOUNG KEYS" became a cut to a medium-wide, the user's call. → Story: "Cut to: the rear bumper of the Aerostar, medium-wide. It is YOUNG KEYS — striped red-and-navy T-shirt, black digital watch — playing hacky sack by himself." (pending)

- **C11** 2026-10-07 · 1.1 · Take C's 17 keyframes were spread evenly; the orb → sack transformation got no more keyframes than the rise, and 13.5 → 15 s changed the plate's light, the foot and the sack's size together, so the sack fell to the asphalt. The user: too many, "placed randomly", concentrate them on the transition. → v5: stretches priced by difficulty (rise and tilt get their ends; the transformation gets four steps of one sprite on one plate). Skill: "Where keyframes go" and problems 23–24. → Story: none beyond C3. (not needed)
- **C12** 2026-10-07 · 1.1–1.2 · The slow motion → normal speed ramp made by keyframe spacing inside one generation broke the end: full speed, then a dead stop, and the kick and catch failed. → The speed change is a cut: 1.1 ends on the landing in slow motion; 1.2 is the normal-speed medium-wide of Keys opening on the flick (match on action), then the catch, then play. Skill: rule 4 and problem 25. → Story: "…lands on the instep of a boy's sneaker. It flattens there, beads settling. A puff of parking-lot dust lifts off the canvas. CUT TO: Normal speed. At the rear bumper of the Aerostar, YOUNG KEYS — striped red-and-navy T-shirt, black digital watch — flicks the hacky sack up off his sneaker and snatches it out of the air, then keeps it going off his knee, by himself." Replaces C5, C6 and C10. (pending)

- **C13** 2026-10-07 · 1.1–1.3 · The scale reveal was played as an approach: the sphere grew from 16 px to 140 px in one shot (the page's "ZOOMS OUT… PULLS BACK… The scale collapses"), and it read as rushing at the camera. The user wants the Flight of the Navigator move: the object reads as a craft until a familiar thing intrudes. → v6: a wide (speck) cuts to a long lens with the sphere at its final size, held there while the camera follows it down; it passes in front of the marquee as big as it, then the foot steps in and it lands. Skill: rule 7 and the reworded rule 2. → Story: replace "The top edge of the pole marquee… bigger than either." and "The lens ZOOMS OUT… the beads inside it shifting as it turns." with: "CLOSER — LONG LENS. The sphere fills a corner of the sky now, black against the cobalt, the hot rim along its underside, turning. The camera comes down with it, never losing it. The top edge of the pole marquee rises into frame behind it, a row of warm tungsten bulbs, then the flat roofline. The sphere drops in front of both, and is bigger than either. The camera settles at asphalt level. A white canvas sneaker steps into frame beneath it, out of nowhere. The sphere lands on the instep: a HACKY SACK — crocheted, panels of faded red and navy, a little lopsided." Also, in "Normal speed. On the landing…", cut the play after the snatch. (pending)

- **C14** 2026-10-07 · 1.1–1.2 · v6 opened on a speck and cut in to the full-size sphere; the user wants ONE size from the first frame, 1.1's end = 1.2's start, the ball lit gradually as it comes down so it reads as a hacky sack before the foot, and no speed change in 1.2 (v6A stalled for 1 s, then the foot stomped in within 0.2 s and the ball landed early). → v7. Skill: rule 7 rewritten. → Story: C13's wording loses "CLOSER — LONG LENS" and "fills a corner of the sky now"; the sphere is the same size from "climbs into the bottom of frame", and the climb paragraph's "a long way up" goes. The descent paragraph gains: "Lower, the lot's light finds it: faded red and navy panels." (pending)

## Story changes to propose

Collected from the corrections above. Offer them when the user accepts scene 1, or when the beat is done; apply nothing without a yes. The screenplay MCP server has no beat-text tool, so the user pastes the new text into the Story tab or gives it to the bot.

1. "Backlit by the last amber… it reads as dark metal with a hot rim of light along one edge — a sphere ship, a long way up, rotating slowly on its axis." → C1 wording.
2. "The top edge of the pole marquee…" through "…the beads inside it shifting as it turns." → C13 wording (replaces C3: the zoom-out reveal is gone; the cut-in, the constant size and the intruding foot replace it).
3. "…lands on the instep of a white canvas low-top sneaker — white laces, white tube sock with two red bands at the top." → C4 wording.
4. "Normal speed. On the landing, …" through "…snatches it out of the air." and "The camera rises from the asphalt up the tube socks and faded jeans to YOUNG KEYS at the rear bumper…" → C12 wording (one passage now: the cut on the landing; the music cue stays on the landing).
5. (folded into 4)
6. (folded into 4)
7. Question: keep "It slows. It hangs among the first stars"? (C7)
