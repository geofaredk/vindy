"""Build Danish region and municipality borders for the map overlay.

Source: Dataforsyningen's open DAWA API (DAGI boundaries), no key needed.
Only borders between two areas are kept — the parts that follow the coast are left out,
because the map already draws the coastline there.

Usage: python3 tools/build_admin.py public/data [cache dir]
Writes public/data/admin.json: {"regions": [[[lon,lat],...],...], "municipalities": [...]}.
"""
import json, math, os, sys, urllib.request

API = "https://api.dataforsyningen.dk"
TOL = {"regions": 0.0015, "municipalities": 0.0008}  # ~150 m / ~80 m


def load(kind, cache_dir):
    path = os.path.join(cache_dir, f"{kind}.geojson")
    if not os.path.exists(path):
        url = f"{API}/{'regioner' if kind == 'regions' else 'kommuner'}?format=geojson"
        print("downloading", url)
        urllib.request.urlretrieve(url, path)
    with open(path) as f:
        return json.load(f)


def rings(feature):
    geom = feature["geometry"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            yield [(round(x, 7), round(y, 7)) for x, y in ring]


def shared_segments(data):
    """Segments that appear in two areas: the borders between them (not the coast)."""
    seen, shared = set(), set()
    for feature in data["features"]:
        for ring in rings(feature):
            for a, b in zip(ring, ring[1:]):
                key = (a, b) if a <= b else (b, a)
                if key in seen:
                    shared.add(key)
                seen.add(key)
    return shared


def join(segments):
    """Chain segments into as few polylines as possible."""
    ends = {}
    for seg in segments:
        ends.setdefault(seg[0], []).append(seg)
        ends.setdefault(seg[1], []).append(seg)
    used, lines = set(), []
    for seg in segments:
        if seg in used:
            continue
        used.add(seg)
        line = [seg[0], seg[1]]
        for at_end in (True, False):
            while True:
                tip = line[-1] if at_end else line[0]
                nxt = next((s for s in ends.get(tip, []) if s not in used), None)
                if not nxt:
                    break
                used.add(nxt)
                other = nxt[1] if nxt[0] == tip else nxt[0]
                line.append(other) if at_end else line.insert(0, other)
        lines.append(line)
    return lines


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        idx, dmax = -1, tol
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dx * (ay - py) - (ax - px) * dy) / norm if norm > 1e-12 else math.hypot(px - ax, py - ay)
            if d > dmax:
                idx, dmax = i, d
        if idx >= 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def main(out, cache_dir="."):
    os.makedirs(cache_dir, exist_ok=True)
    result = {}
    for kind in ("regions", "municipalities"):
        data = load(kind, cache_dir)
        lines = join(sorted(shared_segments(data)))
        lines = [[[round(x, 4), round(y, 4)] for x, y in simplify(l, TOL[kind])] for l in lines]
        result[kind] = [l for l in lines if len(l) > 1]
        print(kind, len(data["features"]), "areas ->", len(result[kind]), "border lines,",
              sum(len(l) for l in result[kind]), "points")
    body = json.dumps(result, separators=(",", ":"))
    with open(os.path.join(out, "admin.json"), "w") as f:
        f.write(body)
    print("admin.json", round(len(body) / 1e3), "KB")


if __name__ == "__main__":
    main(*sys.argv[1:])
