#!/usr/bin/env python3
"""Quality checks for a storyboarded beat: keyframes, clips, seams, object motion — and the
retiming that fixes what the checks find. ffmpeg + the Python standard library only.

  qc.py frames BEAT [LABEL..]           keyframe gate: a chained start frame must be the previous end frame;
                                        an edit keyframe ("Image N exactly — ...") must keep the picture it edits
                                        (start frame -> keyframe -> keyframe -> end frame, in time order)
  qc.py clips BEAT DIR [LABEL..]        clip gate for every cut with a clip: clip ends vs its frames, the clip at each
                                        keyframe's time vs the keyframe image ("keyframe hit"), held frames
                                        to trim, a numbered frame sheet per clip (DIR/<label>.jpg); then every join
                                        between chained clips (seam). Downloads into DIR.
  qc.py track CLIP [--bg IMG] [--color red|dark|any] [--roi x0,x1,y0,y1] [--every N]
                                        follow one moving object: per frame its size, centre and speed; flags
                                        where it speeds up, slows down, enters or leaves the frame
  qc.py retime IN OUT --seg A:B:SPEED [--seg ...] [--shutter F]
                                        speed segments over source frames A..B (B may be "end"; SPEED 4 = 4x
                                        faster, 0.5 = half speed); sped-up frames blend a shutter's worth of
                                        source frames (default 0.6) so fast motion has motion blur
  qc.py constant IN OUT --from F0 --to F1 [--speed H] [--bg IMG] [--color ...] [--roi ...] [--shutter F]
                                        retime F0..F1 so the tracked object moves at ONE constant speed
                                        (H = frame-heights per second; default: its average over the span);
                                        frames before F0 / after F1 are kept as they are
  qc.py seam A B [--bg IMG] [--color ...] [--roi ...]
                                        the join A→B: last/first frame similarity and the object's speed and
                                        direction on each side
  qc.py stitch OUT A B ...              join clips in order; a clip whose first frame repeats the previous clip's
                                        last frame (a chained clip) loses that frame; video only
  qc.py diff IMG IMG                    where two pictures differ, as a 16x9 text grid
  qc.py ssim IMG_OR_CLIP IMG_OR_CLIP    structural similarity of two pictures (a clip means its first frame;
                                        CLIP@last its last frame)

Speeds are in frame-heights per second at 24 fps. A clip's numbered sheet shows every frame number the
retime commands take.
"""
import json, os, re, shutil, subprocess, sys, tempfile, urllib.request

FPS = 24
TW, TH = 192, 108          # tracking resolution
HERE = os.path.dirname(os.path.abspath(__file__))


def ff(*args, capture=True):
    r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args], capture_output=capture)
    if r.returncode:
        raise SystemExit('ffmpeg failed: ' + (r.stderr or b'').decode()[-600:])
    return r


def probe_frames(clip):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
                          'stream=nb_read_frames', '-of', 'csv=p=0', clip], capture_output=True, text=True).stdout
    return int(out.strip() or 0)


def ssim(a, b):
    """SSIM of two pictures at 160x90 grey (fine grain and compression wash out; a rebuilt place scores
    ~0.1-0.6, a good edit of the same shot 0.9+, a clip's first frame vs its keyframe ~0.85-0.9).
    A path ending in @last means that clip's last frame, @<n> its frame n. It does NOT see a small local change (a hand
    that flipped pose still scores 0.9) — that is what diffgrid and looking are for."""
    # Each side is grabbed to a still first: fed to one filter graph, a clip seeked to its end keeps its
    # timestamps and the graph pairs it with the OTHER clip's frame at that time (its last frame).
    tmp = tempfile.mkdtemp(prefix='qcs-')
    try:
        stills = []
        for i, p in enumerate((a, b)):
            out = os.path.join(tmp, f'{i}.png')
            at = re.search(r'@(\d+)$', p)
            if p.endswith('@last'):
                ff('-sseof', '-0.25', '-i', p[:-5], '-update', '1', out)
            elif at:
                ff('-i', p[:at.start()], '-vf', f'select=eq(n\\,{at.group(1)})', '-frames:v', '1', '-fps_mode', 'passthrough', out)
            else:
                ff('-i', p, '-frames:v', '1', out)
            stills.append(out)
        r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'info', '-i', stills[0], '-i', stills[1], '-lavfi',
                            '[0:v]scale=160:90,format=gray[x];[1:v]scale=160:90,format=gray[y];[x][y]ssim',
                            '-f', 'null', '-'], capture_output=True, text=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = re.search(r'All:([0-9.]+)', r.stderr)
    return float(m.group(1)) if m else float('nan')


def frames_raw(clip, w=TW, h=TH, gray=False):
    """Every frame of a clip (or one image) as a bytes object of w*h*(1|3)."""
    fmt = 'gray' if gray else 'rgb24'
    raw = ff('-i', clip, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', fmt, '-').stdout
    size = w * h * (1 if gray else 3)
    return [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]


def colour_test(name):
    if name == 'red':
        return lambda r, g, b: r > 100 and r > 1.6 * g and r > 1.3 * b
    if name == 'dark':
        return lambda r, g, b: r + g + b < 150
    return lambda r, g, b: True


def track(clip, bg=None, colour='red', roi=(0, 1, 0, 1), every=1):
    """[(frame, n_pixels, cx, cy)] — cx, cy in 0..1 of the frame; None when the object is not in frame.
    The object = pixels of its colour that differ from the background: a clean plate (bg, an image
    without the object) or, without one, the per-pixel median of the clip (fine when the object moves)."""
    fr = frames_raw(clip)
    if bg:
        base = frames_raw(bg)[0]
    else:
        sample = fr[::max(1, len(fr) // 25)]
        base = bytes(sorted(f[i] for f in sample)[len(sample) // 2] for i in range(len(fr[0])))
    test = colour_test(colour)
    x0, x1 = int(roi[0] * TW), int(roi[1] * TW)
    y0, y1 = int(roi[2] * TH), int(roi[3] * TH)
    out = []
    for n in range(0, len(fr), every):
        f = fr[n]; cnt = sx = sy = 0
        for y in range(y0, y1):
            row = y * TW * 3
            for x in range(x0, x1):
                i = row + x * 3
                r, g, b = f[i], f[i + 1], f[i + 2]
                if abs(r - base[i]) + abs(g - base[i + 1]) + abs(b - base[i + 2]) > 60 and test(r, g, b):
                    cnt += 1; sx += x; sy += y
        out.append((n, cnt, sx / cnt / TW if cnt >= 4 else None, sy / cnt / TH if cnt >= 4 else None))
    return out


def speeds(tr):
    """Per tracked frame: speed in frame-heights per second (None where the object is missing).
    x is scaled by the frame aspect so a diagonal move counts true distance."""
    aspect = TW / TH
    sp = [None] * len(tr)
    for i in range(1, len(tr)):
        a, b = tr[i - 1], tr[i]
        if a[2] is None or b[2] is None:
            continue
        dn = b[0] - a[0]
        d = (((b[2] - a[2]) * aspect) ** 2 + (b[3] - a[3]) ** 2) ** 0.5
        sp[i] = d / dn * FPS
    return sp


def diffgrid(a, b, cols=16, rows=9):
    """Where two pictures differ, as text: one character per cell, '#' changed, '+' a little, '.' same."""
    w, h = cols * 10, rows * 10
    fa, fb = frames_raw(a, w, h, gray=True)[0], frames_raw(b, w, h, gray=True)[0]
    lines = []
    for r in range(rows):
        row = ''
        for c in range(cols):
            d = sum(abs(fa[(r * 10 + y) * w + c * 10 + x] - fb[(r * 10 + y) * w + c * 10 + x]) for y in range(10) for x in range(10)) / 100
            row += '#' if d > 22 else '+' if d > 10 else '.'
        lines.append(row)
    return lines


def motion_energy(clip):
    """Mean absolute grey difference to the previous frame, per frame (frame 0 = 0)."""
    fr = frames_raw(clip, 160, 90, gray=True)
    e = [0.0]
    for a, b in zip(fr, fr[1:]):
        e.append(sum(abs(x - y) for x, y in zip(a, b)) / len(a))
    return e


def holds(e):
    """Leading / trailing runs of frames where nothing moves: (first_moving, last_moving) frame numbers."""
    moving = sorted(e[1:])[int(len(e) * 0.75)] or 1.0
    still = [x < 0.2 * moving for x in e]
    first = next((i for i in range(1, len(e)) if not still[i]), 1) - 1
    last = next((i for i in range(len(e) - 1, 0, -1) if not still[i]), len(e) - 1)
    return max(first, 0), last


def sheet(clip, out, every=3, cols=9):
    ff('-i', clip, '-vf', f'select=not(mod(n\\,{every})),scale=240:-1,'
       f'drawtext=text=%{{n}}*{every}:x=4:y=4:fontsize=15:fontcolor=yellow,tile={cols}x4',
       '-frames:v', '1', '-fps_mode', 'passthrough', out)


def render_picks(src, out, picks):
    """Write OUT from SRC: output frame k is the average of source frames picks[k] = (a, b) inclusive."""
    tmp = tempfile.mkdtemp(prefix='qc-')
    try:
        ff('-i', src, os.path.join(tmp, 's%05d.png'))
        od = os.path.join(tmp, 'o'); os.makedirs(od)
        for k, (a, b) in enumerate(picks):
            dst = os.path.join(od, f'{k:05d}.png')
            if a == b:
                shutil.copy(os.path.join(tmp, f's{a + 1:05d}.png'), dst)
            else:
                ins = []
                for s in range(a, b + 1):
                    ins += ['-i', os.path.join(tmp, f's{s + 1:05d}.png')]
                ff(*ins, '-filter_complex', f'mix=inputs={b - a + 1}', '-frames:v', '1', dst)
        ff('-framerate', str(FPS), '-i', os.path.join(od, '%05d.png'), '-an', '-c:v', 'libx264', '-crf', '16',
           '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f'{out}: {len(picks)} frames, {len(picks) / FPS:.2f}s')


def seg_picks(segs, nsrc, shutter):
    picks = []
    for a, b, speed in segs:
        b = nsrc - 1 if b == 'end' else int(b)
        a = int(a); t = float(a)
        while t <= b + 1e-9:
            s = int(round(t))
            span = max(1, int(round(speed * shutter))) if speed > 1 else 1
            picks.append((min(s, b), min(s + span - 1, b)))
            t += speed
    return picks


def opts(args, flag, default=None, cast=str):
    if flag in args:
        i = args.index(flag); v = args[i + 1]; del args[i:i + 2]; return cast(v)
    return default


def roi_of(s):
    return tuple(float(x) for x in s.split(',')) if s else (0, 1, 0, 1)


def mcp(name, a):
    exec(open(os.path.join(HERE, 'sb.py')).read().split('cmd = args[0]')[0], g := {'__name__': 'sbmod'})
    return g['call'](name, a)


def beat_cuts(beat):
    cs = [c for s in mcp('get_scenes', {'beat': int(beat) if str(beat).isdigit() else beat})['scenes'] for c in s['cuts']]
    for i, c in enumerate(cs):
        p = cs[i - 1] if i else None
        t = ' '.join((c['start_frame']['prompt'] or '').split())
        c['prev'] = p if p and t and p['scene_id'] == c['scene_id'] and t == ' '.join((p['end_frame']['prompt'] or '').split()) else None
    return cs


def guide_frame(at_seconds, n):
    """The source frame a keyframe at `at_seconds` is pinned to: the renderer snaps it down to the
    8-frame latent grid and keeps it inside [8, n-9] (src/comfy/ltxKeyframeWorkflow.js)."""
    f = int(round(at_seconds * FPS)) // 8 * 8
    return max(8, min(f, n - 9))


def fetch(url, path):
    if not os.path.exists(path):
        urllib.request.urlretrieve(url, path)
    return path


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return
    cmd = args.pop(0)
    bg = opts(args, '--bg'); colour = opts(args, '--color', 'red'); roi = roi_of(opts(args, '--roi'))
    shutter = opts(args, '--shutter', 0.6, float)

    if cmd == 'ssim':
        print(f'{ssim(args[0], args[1]):.3f}')

    elif cmd == 'diff':
        print('\n'.join(diffgrid(args[0], args[1])))

    elif cmd == 'track':
        every = opts(args, '--every', 1, int)
        tr = track(args[0], bg, colour, roi, every); sp = speeds(tr)
        inside = [t for t in tr if t[2] is not None]
        for (n, cnt, cx, cy), v in zip(tr, sp):
            print(f'{n:4d} px={cnt:4d} ' + (f'x={cx:.3f} y={cy:.3f}' if cx is not None else 'out of frame') +
                  (f'  speed={v:.2f} H/s' if v is not None else ''))
        vals = [v for v in sp if v is not None]
        if vals:
            med = sorted(vals)[len(vals) // 2]
            print(f'median speed {med:.2f} H/s over {len(vals)} steps; frames in view: '
                  f'{inside[0][0] if inside else "-"}..{inside[-1][0] if inside else "-"}')
            for i, v in enumerate(sp):
                if v is not None and med > 0.05 and (v < 0.5 * med or v > 1.8 * med):
                    print(f'  frame {tr[i][0]}: {"SLOWS" if v < med else "SPEEDS UP"} to {v:.2f} H/s (median {med:.2f})')

    elif cmd == 'retime':
        src, out = args[0], args[1]
        segs = []
        while '--seg' in args:
            a, b, s = opts(args, '--seg').split(':'); segs.append((a, b, float(s)))
        render_picks(src, out, seg_picks(segs, probe_frames(src), shutter))

    elif cmd == 'constant':
        src, out = args[0], args[1]
        f0 = opts(args, '--from', None, int); f1 = opts(args, '--to', None, int)
        want = opts(args, '--speed', None, float)
        n = probe_frames(src)
        tr = track(src, bg, colour, roi)
        pts = [(t[0], t[2] * TW / TH, t[3]) for t in tr if t[2] is not None and f0 <= t[0] <= f1]
        if len(pts) < 2:
            raise SystemExit('the object is not tracked between those frames')
        # cumulative path length, frame-heights, monotone
        cum = [(pts[0][0], 0.0)]
        for (fa, xa, ya), (fb, xb, yb) in zip(pts, pts[1:]):
            cum.append((fb, cum[-1][1] + ((xb - xa) ** 2 + (yb - ya) ** 2) ** 0.5))
        total = cum[-1][1]
        if want is None:
            want = total / ((pts[-1][0] - pts[0][0]) / FPS)
        step = want / FPS
        picks = [(i, i) for i in range(0, pts[0][0])]
        k = 0
        while k * step <= total + 1e-9:
            target = k * step
            j = next(i for i, (f, s) in enumerate(cum) if s >= target - 1e-9)
            nxt = next((i for i, (f, s) in enumerate(cum) if s >= target + step - 1e-9), len(cum) - 1)
            a = cum[j][0]; b = max(a, cum[nxt][0] - 1)
            span = max(1, int(round((b - a + 1) * shutter)))
            picks.append((a, a + span - 1))
            k += 1
        picks += [(i, i) for i in range(pts[-1][0] + 1, n)]
        print(f'object path {total:.2f} H over source frames {pts[0][0]}..{pts[-1][0]}; constant {want:.2f} H/s '
              f'= {int(total / step) + 1} frames')
        render_picks(src, out, picks)

    elif cmd == 'seam':
        a, b = args[0], args[1]
        v = ssim(a + "@last", b)
        print(f'last→first similarity {v:.3f}' + ('' if v > 0.85 else '  ← VISIBLE JUMP'))
        ta, tb = track(a, bg, colour, roi), track(b, bg, colour, roi)
        sa, sb = speeds(ta)[-4:], speeds(tb)[1:5]
        fa = [v for v in sa if v is not None]; fb = [v for v in sb if v is not None]
        print('speed into the join ' + (f'{sum(fa) / len(fa):.2f} H/s' if fa else 'n/a (object not in view)') +
              ', out of it ' + (f'{sum(fb) / len(fb):.2f} H/s' if fb else 'n/a (object not in view)'))
        if fa and fb:
            r = (sum(fb) / len(fb)) / max(1e-6, sum(fa) / len(fa))
            if r < 0.7 or r > 1.4:
                print(f'  SPEED JUMP x{r:.2f} across the join')

    elif cmd == 'stitch':
        out, clips = args[0], args[1:]
        parts, ins = [], []
        for i, c in enumerate(clips):
            ins += ['-i', c]
            # a chained clip opens on the previous clip's last frame: drop that duplicate
            dup = i > 0 and ssim(clips[i - 1] + '@last', c) > 0.95
            parts.append(f'[{i}:v]' + ('trim=start_frame=1,' if dup else '') + f'setpts=PTS-STARTPTS,fps={FPS},'
                         f'scale=1280:704:force_original_aspect_ratio=decrease,pad=1280:704:-1:-1,setsar=1[v{i}]')
        graph = ';'.join(parts) + ';' + ''.join(f'[v{i}]' for i in range(len(clips))) + f'concat=n={len(clips)}:v=1:a=0[v]'
        ff(*ins, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow',
           '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out)
        print(f'{out}: {probe_frames(out) / FPS:.2f}s')

    elif cmd == 'frames':
        beat, only = args[0], set(args[1:])
        tmp = tempfile.mkdtemp(prefix='qcf-')
        for c in beat_cuts(beat):
            if only and c['label'] not in only:
                continue
            s, e = c['start_frame'], c['end_frame']
            if not (s.get('image_url') and e.get('image_url')):
                print(f'{c["label"]}: missing a frame'); continue
            sp = fetch(s['image_url'], os.path.join(tmp, f'{s["image_id"]}.png'))
            ep = fetch(e['image_url'], os.path.join(tmp, f'{e["image_id"]}.png'))
            line = f'{c["label"]}:'
            if c['prev']:
                pe = c['prev']['end_frame']
                pp = fetch(pe['image_url'], os.path.join(tmp, f'{pe["image_id"]}.png'))
                v = ssim(pp, sp); line += f' start = {c["prev"]["label"]} end {v:.3f}' + ('' if v > 0.97 else '  ← NOT THE SAME PICTURE')
            # start -> each keyframe (time order) -> end: every edit is checked against the picture it edits
            chain = [('start', sp, None)]
            for k in sorted(c.get('keyframes') or [], key=lambda k: k['at_seconds']):
                if not k.get('image_url'):
                    line += f'  kf@{k["at_seconds"]}s: no image'; continue
                chain.append((f'kf@{k["at_seconds"]}s', fetch(k['image_url'], os.path.join(tmp, f'{k["image_id"]}.png')), k['prompt']))
            chain.append(('end', ep, e['prompt']))
            print(line)
            for (pn, pp_, _), (nn, np_, prompt) in zip(chain, chain[1:]):
                edit = bool(re.match(r'\s*Image \d+ exactly', prompt or ''))
                v = ssim(pp_, np_)
                row = f'    {nn} vs {pn} {v:.3f}' + ('  (edit keyframe)' if edit else '')
                if edit and v < 0.8:
                    row += '  ← the edit moved the camera or rebuilt the place'
                print(row)
                if edit:
                    print(f'      where {nn} differs from {pn} (check it is only the stated difference):')
                    for g in diffgrid(pp_, np_):
                        print('        ' + g)
        shutil.rmtree(tmp, ignore_errors=True)

    elif cmd == 'clips':
        beat, d, only = args[0], args[1], set(args[2:])
        os.makedirs(d, exist_ok=True)
        cs = beat_cuts(beat); have = {}
        for c in cs:
            if only and c['label'] not in only:
                continue
            v = c.get('video') or {}
            if not v.get('url'):
                print(f'{c["label"]}: no clip'); continue
            lab = c['label'].replace('.', '_')
            clip = fetch(v['url'], os.path.join(d, f'{lab}.mp4')); have[c['label']] = clip
            sp = fetch(c['start_frame']['image_url'], os.path.join(d, f'{lab}_start.png'))
            ep = fetch(c['end_frame']['image_url'], os.path.join(d, f'{lab}_end.png'))
            n = probe_frames(clip)
            a, b = ssim(clip, sp), ssim(clip + '@last', ep)
            first, last = holds(motion_energy(clip))
            note = []
            if a < 0.8: note.append('opens off its start frame')
            if b < 0.8: note.append('ends off its end frame')
            # keyframe hits: the clip at each keyframe's frame vs the keyframe image
            hits = []
            for k in sorted(c.get('keyframes') or [], key=lambda k: k['at_seconds']):
                if not k.get('image_url'): continue
                kp = fetch(k['image_url'], os.path.join(d, f'{lab}_kf{str(k["at_seconds"]).replace(".", "_")}.png'))
                f = guide_frame(k['at_seconds'], n)
                h = ssim(f'{clip}@{f}', kp)
                hits.append(f'kf@{k["at_seconds"]}s(f{f}) {h:.2f}')
                if h < 0.7: note.append(f'misses its keyframe at {k["at_seconds"]} s (frame {f}: {h:.2f})')
            if hits and bg:
                # measured speed per keyframe interval, when a clean plate is given
                tr = track(clip, bg, colour, roi); sp_ = speeds(tr)
                marks = [0] + [guide_frame(k['at_seconds'], n) for k in sorted(c['keyframes'], key=lambda k: k['at_seconds']) if k.get('image_url')] + [n - 1]
                for f0, f1 in zip(marks, marks[1:]):
                    vals = [v for (fr, *_), v in zip(tr, sp_) if v is not None and f0 <= fr <= f1]
                    if vals: hits.append(f'speed f{f0}..{f1} {sorted(vals)[len(vals) // 2]:.2f} H/s')
            if first > 6: note.append(f'nothing moves until frame {first}')
            if last < n - 7: note.append(f'nothing moves after frame {last} (trim {n - 1 - last} frames)')
            sheet(clip, os.path.join(d, f'{lab}.jpg'))
            print(f'{c["label"]}: {n} frames  start {a:.2f} end {b:.2f}  ' + (('  '.join(hits) + '  ') if hits else '') + ('; '.join(note) or 'ok') + f'  sheet {d}/{lab}.jpg')
        for c in cs:
            if c['prev'] and c['label'] in have and c['prev']['label'] in have:
                v = ssim(have[c['prev']['label']] + '@last', have[c['label']])
                print(f'seam {c["prev"]["label"]}→{c["label"]}: last/first similarity {v:.2f}' + ('' if v > 0.85 else '  ← VISIBLE JUMP'))
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
