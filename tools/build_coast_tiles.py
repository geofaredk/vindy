"""Build high-resolution coastline/border tiles for zoomed-in map views.

Source: GSHHG 2.3.7 (Wessel & Smith, NOAA/SOEST), full resolution:
  GSHHS_shp/f/GSHHS_f_L1  (shorelines), GSHHS_shp/f/GSHHS_f_L2 (lakes; GSHHG also stores
  enclosed fjords such as the western Limfjord and Ringkøbing Fjord here),
  WDBII_shp/f/WDBII_border_f_L1 (national borders)
Download: https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip

Usage: python3 tools/build_coast_tiles.py <extracted gshhg dir> public/data
Writes public/data/coast/<x>_<y>.json, one per 1°x1° cell, plus the simplified overview
public/data/coast.json for low zooms: {"coast": [[[lon,lat],...],...], "borders": [...]}.

Coast lines are oriented so that water is always on the LEFT of the direction of travel
(in lon/lat, north up); the map uses this to draw the shadow on the sea side.
"""
import json, math, os, sys
import shapefile  # pyshp

WEST, EAST, SOUTH, NORTH = -6, 28, 48, 65
TOL = 0.00025  # Douglas-Peucker tolerance in degrees (~25 m)
# Lakes/fjords (L2) to include, by area: smaller ones inside Denmark, only large elsewhere.
DK_BOX = (7.5, 54.4, 15.5, 58.0)
MIN_LAKE_KM2_DK, MIN_LAKE_KM2_ELSEWHERE = 15, 150


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
            # Closed rings (islands) start and end on the same point: measure the distance
            # to that point instead, or the whole ring would collapse.
            d = abs(dx * (ay - py) - (ax - px) * dy) / norm if norm > 1e-12 else math.hypot(px - ax, py - ay)
            if d > dmax:
                idx, dmax = i, d
        if idx >= 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def signed_area(pts):
    return sum(pts[k][0] * pts[k + 1][1] - pts[k + 1][0] * pts[k][1] for k in range(len(pts) - 1)) / 2


def lines_from(path, min_area=None, water_left=None):
    """water_left: 'land' for polygons whose inside is land (shorelines), 'water' for
    polygons whose inside is water (lakes); None leaves the direction as is (borders)."""
    sf = shapefile.Reader(path)
    area_field = next((i for i, f in enumerate(sf.fields[1:]) if f[0].lower() == "area"), None)
    for i, shape in enumerate(sf.iterShapes()):
        x0, y0, x1, y1 = shape.bbox
        if x1 < WEST or x0 > EAST or y1 < SOUTH or y0 > NORTH:
            continue
        if min_area and area_field is not None and not min_area(shape.bbox, sf.record(i)[area_field]):
            continue
        parts = list(shape.parts) + [len(shape.points)]
        for a, b in zip(parts[:-1], parts[1:]):
            pts = shape.points[a:b]
            if water_left:
                ccw = signed_area(pts) > 0
                # Water on the left: land polygons run clockwise, water polygons anticlockwise.
                if (water_left == "land") == ccw:
                    pts = pts[::-1]
            yield pts


KINDS = ("coast", "borders")


def add_to_cells(cells, kind, line, cell_of=lambda x, y: (math.floor(x), math.floor(y)), bounds=(WEST, EAST, SOUTH, NORTH)):
    # Split the line into runs per 1° cell; a segment belongs to the cell of its midpoint,
    # and each run keeps its neighbouring points so tiles join seamlessly.
    run, cell = [], None
    for i in range(len(line) - 1):
        (x0, y0), (x1, y1) = line[i], line[i + 1]
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        if not (bounds[0] <= mx < bounds[1] and bounds[2] <= my < bounds[3]):
            if run:
                cells.setdefault(cell, {k: [] for k in KINDS})[kind].append(run)
            run, cell = [], None
            continue
        c = cell_of(mx, my)
        if c != cell:
            if run:
                cells.setdefault(cell, {k: [] for k in KINDS})[kind].append(run)
            run, cell = [line[i]], c
        run.append(line[i + 1])
    if run:
        cells.setdefault(cell, {k: [] for k in KINDS})[kind].append(run)


# Overview (low zooms): wider area, ~1 km detail, small islands and lakes left out.
OV_BOUNDS = (-15, 35, 42, 70)
OV_TOL = 0.012
OV_MIN_ISLAND_KM2, OV_MIN_LAKE_KM2 = 10, 300


def main(src, out):
    tiles_dir = os.path.join(out, "coast")
    os.makedirs(tiles_dir, exist_ok=True)
    cells, overview = {}, {}
    def lake_filter(bbox, area):
        x0, y0, x1, y1 = bbox
        in_dk = x0 < DK_BOX[2] and x1 > DK_BOX[0] and y0 < DK_BOX[3] and y1 > DK_BOX[1]
        return area >= (MIN_LAKE_KM2_DK if in_dk else MIN_LAKE_KM2_ELSEWHERE)

    sources = (
        ("coast", "GSHHS_shp/f/GSHHS_f_L1", None, "land", lambda b, a: a >= OV_MIN_ISLAND_KM2),
        ("coast", "GSHHS_shp/f/GSHHS_f_L2", lake_filter, "water", lambda b, a: a >= OV_MIN_LAKE_KM2),
        ("borders", "WDBII_shp/f/WDBII_border_f_L1", None, None, None),
    )
    global WEST, EAST, SOUTH, NORTH
    tile_bounds = (WEST, EAST, SOUTH, NORTH)
    for kind, path, flt, orient, ov_flt in sources:
        n = 0
        WEST, EAST, SOUTH, NORTH = OV_BOUNDS[0], OV_BOUNDS[1], OV_BOUNDS[2], OV_BOUNDS[3]  # read the wider area
        for pts in lines_from(os.path.join(src, path), None, orient):
            line = [tuple(p) for p in pts]
            xs = [p[0] for p in line]; ys = [p[1] for p in line]
            bbox = (min(xs), min(ys), max(xs), max(ys))
            area = abs(signed_area(line)) * 111 * 111 * math.cos(math.radians((bbox[1] + bbox[3]) / 2))
            if not flt or flt(bbox, area):
                add_to_cells(cells, kind, line, bounds=tile_bounds)
            if not ov_flt or ov_flt(bbox, area):
                add_to_cells(overview, kind, line, cell_of=lambda x, y: (0, 0), bounds=OV_BOUNDS)
            n += 1
        print(kind, path.split("/")[-1], n, "lines")
    WEST, EAST, SOUTH, NORTH = tile_bounds

    def finish(data, tol):
        for kind in data:
            data[kind] = [[[round(x, 4), round(y, 4)] for x, y in simplify(r, tol)] for r in data[kind]]
            data[kind] = [r for r in data[kind] if len(r) > 1]
        return json.dumps(data, separators=(",", ":"))

    total = 0
    for (cx, cy), data in cells.items():
        body = finish(data, TOL)
        with open(os.path.join(tiles_dir, f"{cx}_{cy}.json"), "w") as f:
            f.write(body)
        total += len(body)
    with open(os.path.join(tiles_dir, "index.json"), "w") as f:
        json.dump(sorted(f"{cx}_{cy}" for cx, cy in cells), f)
    print(len(cells), "tiles,", round(total / 1e6, 1), "MB")
    body = finish(overview.get((0, 0), {k: [] for k in KINDS}), OV_TOL)
    with open(os.path.join(out, "coast.json"), "w") as f:
        f.write(body)
    print("overview", round(len(body) / 1e3), "KB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
