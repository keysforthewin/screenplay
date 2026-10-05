#!/usr/bin/env python3
"""Storyboard helpers over the screenplay MCP server (http://localhost:3002/mcp).

  sb.py catalog BEAT                 compact list of the beat's reference pool
  sb.py refsheet OUT.jpg ID [ID...]  contact sheet of reference images (numbered in argument order)
  sb.py link-end BEAT                end frame refs = [own start frame image] + its first 3 library refs
  sb.py verify BEAT                  check every cut: prompts, 4 refs per frame, images, end ref 1 = start image
  sb.py sheet BEAT OUTDIR [LABEL..]  contact sheet(s) of rendered frames, one per scene: start,end pairs in cut order
Add --project "Title" anywhere for a non-default project.
"""
import json, os, subprocess, sys, urllib.request

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

def cuts(beat):
    return [c for s in call("get_scenes", {"beat": beat})["scenes"] for c in s["cuts"]]

def montage(files, out, cols=4):
    subprocess.run(["montage", *files, "-resize", "480x270", "-geometry", "480x270+3+3", "-tile", f"{cols}x", out], check=True)

def beat_arg(v): return int(v) if v.isdigit() else v

cmd = args[0] if args else ""
if cmd == "catalog":
    for im in call("list_reference_images", {"beat": beat_arg(args[1])})["images"]:
        d = " ".join((im.get("description") or "").split())[:200]
        print(f'{im["image_id"]} [{im["owner_type"]}: {im["owner_name"]}] {im["label"]} :: {d}')
elif cmd == "refsheet":
    out, ids = args[1], args[2:]
    tmp = out + ".d"; os.makedirs(tmp, exist_ok=True); files = []
    for n, i in enumerate(ids, 1):
        f = f"{tmp}/{n:03d}.png"; urllib.request.urlretrieve(f"{WEB}/image/{i}", f); files.append(f)
        print(n, i)
    montage(files, out)
elif cmd == "link-end":
    n = 0
    for c in cuts(beat_arg(args[1])):
        s, ids = c["start_frame"]["image_id"], c["end_frame"]["reference_ids"]
        if not s: print("no start image:", c["label"]); continue
        if s not in ids:
            call("update_cut", {"cut_id": c["id"], "end_frame_reference_ids": [s] + ids[:3]}); n += 1
    print("end reference lists updated:", n)
elif cmd == "verify":
    cs = cuts(beat_arg(args[1])); bad = []
    for c in cs:
        s, e = c["start_frame"], c["end_frame"]; why = []
        if not (c["prompt"] and s["prompt"] and e["prompt"]): why.append("missing prompt")
        if len(s["reference_ids"]) != 4: why.append(f'start refs={len(s["reference_ids"])}')
        if len(e["reference_ids"]) != 4: why.append(f'end refs={len(e["reference_ids"])}')
        if not s["image_id"]: why.append("no start image")
        if not e["image_id"]: why.append("no end image")
        if s["image_id"] and (not e["reference_ids"] or e["reference_ids"][0] != s["image_id"]): why.append("end ref 1 is not the start frame")
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
