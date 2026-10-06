#!/usr/bin/env python3
"""Storyboard helpers over the screenplay MCP server (http://localhost:3002/mcp).

  sb.py catalog BEAT                 compact list of the beat's reference pool (prop plates are tagged [PROP: name])
  sb.py refsheet OUT.jpg ID [ID...]  contact sheet of reference images (numbered in argument order)
  sb.py refs BEAT [LABEL..]          per frame, the references as the renderer binds them: "Image N  role  label"
  sb.py link-end BEAT                end frame refs = its first 3 library refs + [own start frame image] (render.mjs's end pass does this too)
  sb.py verify BEAT                  check every cut: prompts (relative wording, Image N vs refs), 4 refs per frame, images, start image last in end refs; lists the chains
  sb.py sheet BEAT OUTDIR [LABEL..]  contact sheet(s) of rendered frames, one per scene: start,end pairs in cut order
Add --project "Title" anywhere for a non-default project.

The renderer sends a frame's references in STORED order and binds them "Image 1",
"Image 2"... in that order, so the Nth id in reference_ids is Image N in the prompt.
Roles come from the beat catalog: character artwork = identity, wardrobe plate =
wardrobe, prop plate = prop, set artwork = look, the cut's own start frame on an
end frame = continuity (list it last).

A cut whose start frame prompt is the same text as the previous cut's end frame
prompt (same scene) is CHAINED - one continuous shot. Its start frame is a copy
of the previous end frame, made by render.mjs's end pass (never rendered).
"""
import json, os, re, subprocess, sys, urllib.request

MCP = os.environ.get("SCREENPLAY_MCP", "http://localhost:3002/mcp")
WEB = os.environ.get("SCREENPLAY_WEB", "http://localhost:3000")
args = sys.argv[1:]
PROJECT = None
if "--project" in args:
    i = args.index("--project"); PROJECT = args[i + 1]; del args[i:i + 2]

def call(name, a):
    if PROJECT and "beat" in a: a = {**a, "project": PROJECT}
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": a}}).encode()
    req = urllib.request.Request(MCP, data=body, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    raw = urllib.request.urlopen(req, timeout=180).read().decode()
    for line in raw.splitlines():
        if line.startswith("data:"): raw = line[5:]
    r = json.loads(raw)["result"]
    txt = r["content"][0]["text"]
    if r.get("isError"): raise SystemExit(f"{name}: {txt}")
    return json.loads(txt)

def norm(s): return " ".join((s or "").split())

def cuts(beat):
    """Every cut in page order; c["prev"] = the cut it continues (chained), else None."""
    cs = [c for s in call("get_scenes", {"beat": beat})["scenes"] for c in s["cuts"]]
    for i, c in enumerate(cs):
        p, t = (cs[i - 1] if i else None), norm(c["start_frame"]["prompt"])
        c["prev"] = p if p and t and p["scene_id"] == c["scene_id"] and t == norm(p["end_frame"]["prompt"]) else None
    return cs

def catalog(beat):
    """image id -> (role, label) as the renderer labels it (anything else is a look reference)."""
    out = {}
    for im in call("list_reference_images", {"beat": beat})["images"]:
        if im.get("prop"): out[im["image_id"]] = ("prop", im["prop"])
        elif im.get("wardrobe_plate"): out[im["image_id"]] = ("wardrobe", f'{im["owner_name"]}\'s wardrobe plate')
        elif im["owner_type"] == "character": out[im["image_id"]] = ("identity", im["owner_name"])
        else: out[im["image_id"]] = ("look", f'the set "{im["owner_name"]}"')
    return out

def bound(c, frame, cat):
    """[(n, role, label, id)] for one frame, in the order the renderer binds them."""
    fr = c[frame + "_frame"]; start = c["start_frame"]["image_id"] if frame == "end" else None
    rows = []
    for n, i in enumerate(fr["reference_ids"], 1):
        role, label = ("continuity", "the opening frame of this shot") if i == start else cat.get(i, ("look", "this subject (not in the beat catalog!)"))
        rows.append((n, role, label, i))
    return rows

def mentions(prompt): return {int(m) for m in re.findall(r"\bImage (\d+)\b", prompt or "")}

RELATIVE = re.compile(r"\b(same shot|same camera position as|continuing|as before|previous (cut|keyframe|frame)|opening frame|the \w+ continues|still \w+ing as)\b", re.I)
def relative(prompt):
    """Wording that refers to another prompt - meaningless to a model that sees only this one."""
    return sorted({m.group(0).lower() for m in RELATIVE.finditer(prompt or "")})

def montage(files, out, cols=4):
    subprocess.run(["montage", *files, "-resize", "480x270", "-geometry", "480x270+3+3", "-tile", f"{cols}x", out], check=True)

def beat_arg(v): return int(v) if v.isdigit() else v

cmd = args[0] if args else ""
if cmd == "catalog":
    for im in call("list_reference_images", {"beat": beat_arg(args[1])})["images"]:
        d = " ".join((im.get("description") or "").split())[:200]
        tag = f'PROP: {im["prop"]}' if im.get("prop") else f'{im["owner_type"]}: {im["owner_name"]}' + (" (wardrobe plate)" if im.get("wardrobe_plate") else "")
        print(f'{im["image_id"]} [{tag}] {im["label"]} :: {d}')
elif cmd == "refsheet":
    out, ids = args[1], args[2:]
    tmp = out + ".d"; os.makedirs(tmp, exist_ok=True); files = []
    for n, i in enumerate(ids, 1):
        f = f"{tmp}/{n:03d}.png"; urllib.request.urlretrieve(f"{WEB}/image/{i}", f); files.append(f)
        print(n, i)
    montage(files, out)
elif cmd == "refs":
    beat, only = beat_arg(args[1]), set(args[2:]); cat = catalog(beat)
    for c in cuts(beat):
        if only and c["label"] not in only: continue
        for frame in ("start", "end"):
            if frame == "start" and c["prev"]: print(f'{c["label"]} start: chained (copy of {c["prev"]["label"]} end), no references'); continue
            rows = bound(c, frame, cat); named = mentions(c[frame + "_frame"]["prompt"])
            print(f'{c["label"]} {frame}:')
            for n, role, label, i in rows:
                print(f'  Image {n}  {role:10} {label}  {i}' + ("" if n in named else "  (not named in the prompt)"))
            for n in sorted(named - {r[0] for r in rows}): print(f'  Image {n}  -- named in the prompt but there is no image {n}')
elif cmd == "link-end":
    n = 0
    for c in cuts(beat_arg(args[1])):
        s, ids = c["start_frame"]["image_id"], c["end_frame"]["reference_ids"]
        if c["prev"]: continue  # linked by the end pass, when the previous end frame exists
        if not s: print("no start image:", c["label"]); continue
        if not ids or ids[-1] != s:
            call("update_cut", {"cut_id": c["id"], "end_frame_reference_ids": [i for i in ids if i != s][:3] + [s]}); n += 1
    print("end reference lists updated:", n)
elif cmd == "verify":
    beat = beat_arg(args[1]); cs = cuts(beat); cat = catalog(beat); bad = []; chains = []
    for c in cs:
        if c["prev"]: (chains[-1] if chains and chains[-1][-1] == c["prev"]["label"] else chains.append([c["prev"]["label"]]) or chains[-1]).append(c["label"])
    for ch in chains: print("continuous shot:", " → ".join(ch))
    for c in cs:
        s, e = c["start_frame"], c["end_frame"]; why = []
        if not (c["prompt"] and s["prompt"] and e["prompt"]): why.append("missing prompt")
        if c["prev"]:
            src = c["prev"]["end_frame"]["image_id"]
            if s["image_id"] and s.get("model") != f"chain:{src}": why.append(f'start frame is not the end frame of {c["prev"]["label"]}')
        elif len(s["reference_ids"]) != 4: why.append(f'start refs={len(s["reference_ids"])}')
        if len(e["reference_ids"]) != 4: why.append(f'end refs={len(e["reference_ids"])}')
        if not s["image_id"]: why.append("no start image")
        if not e["image_id"]: why.append("no end image")
        if s["image_id"]:
            if s["image_id"] not in e["reference_ids"]: why.append("start frame not in end refs")
            elif e["reference_ids"][-1] != s["image_id"]: why.append("start frame is not the LAST end ref (the end prompt's Image 4)")
        rel = relative(c["prompt"])
        if rel: why.append(f'video prompt refers outside itself: {", ".join(rel)}')
        for frame in ("start", "end"):
            if frame == "start" and c["prev"]: continue
            rel = relative(c[frame + "_frame"]["prompt"])
            if rel: why.append(f'{frame} prompt refers outside itself: {", ".join(rel)}')
            rows = bound(c, frame, cat); named = mentions(c[frame + "_frame"]["prompt"]); have = {r[0] for r in rows}
            if named - have: why.append(f'{frame} prompt names Image {",".join(map(str, sorted(named - have)))} but has no such image')
            if have - named: why.append(f'{frame} refs not named in the prompt: Image {",".join(map(str, sorted(have - named)))}')
        if why: bad.append(f'{c["label"]}: {", ".join(why)}')
    print(f"{len(cs)} cuts, {len(bad)} with problems"); print("\n".join(bad))
elif cmd == "sheet":
    beat, outdir, only = beat_arg(args[1]), args[2], set(args[3:])
    os.makedirs(outdir, exist_ok=True); by = {}
    for c in cuts(beat):
        if only and c["label"] not in only: continue
        for f, fr in (("a", c["start_frame"]), ("b", c["end_frame"])):
            if not fr["image_id"]: continue
            p = f'{outdir}/{c["label"]}{f}.png'; urllib.request.urlretrieve(fr["image_url"], p)
            by.setdefault("fix" if only else c["label"].split(".")[0], []).append(p)
    for k, files in by.items():
        out = f"{outdir}/sheet-{k}.jpg"; montage(files, out); print(out, "←", " ".join(os.path.basename(f)[:-4] for f in files))
else:
    print(__doc__)
