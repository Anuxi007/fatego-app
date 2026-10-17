"""Builds data/banners.json: current (and starting-soon) summon banners for NA and JP,
from Atlas Academy's timer export, with the featured servants / CEs resolved to names and faces."""
import json
import os
import time
import urllib.request

API = "https://api.atlasacademy.io"
SOON = 30 * 86400         # also keep announced banners (up to a month ahead); the app hides them until they open
MAX_LEN = 120 * 86400     # skip permanent pools (story summon etc.)


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fgo-codex-banners"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(3 + attempt * 5)


def units():
    out = {}
    for kind, base in (("s", "basic_servant"), ("c", "basic_equip")):
        en = {x["id"]: x for x in get(f"{API}/export/JP/{base}_lang_en.json")}
        ja = {x["id"]: x for x in get(f"{API}/export/JP/{base}.json")}
        na = {x["id"]: x for x in get(f"{API}/export/NA/{base}.json")}
        for i, x in en.items():
            n = na.get(i, x)
            out[i] = {"k": kind, "n": n.get("name") or x.get("name"), "j": ja.get(i, x).get("name"),
                      "r": x.get("rarity", 0), "f": x.get("face"), "no": x.get("collectionNo", 0)}
            if kind == "s":
                out[i]["c"] = x.get("className")
    return out


def main():
    now = int(time.time())
    regions = {}
    used = set()
    for region, tz in (("NA", "America/Los_Angeles"), ("JP", "Asia/Tokyo")):
        if region == "JP":
            data = get(f"{API}/export/JP/timer_data_lang_en.json")
            ja = {g["id"]: g["name"] for g in get(f"{API}/export/JP/timer_data.json").get("gachas", [])}
        else:
            data = get(f"{API}/export/NA/timer_data.json")
            ja = {}
        out = []
        for g in data.get("gachas", []):
            start, end = g.get("openedAt", 0), g.get("closedAt", 0)
            if end <= now or start > now + SOON or end - start > MAX_LEN:
                continue
            feat = [i for i in g.get("featuredSvtIds") or []]
            out.append({"id": g["id"], "name": g.get("name", ""), "jname": ja.get(g["id"], g.get("name", "")),
                        "type": g.get("type", ""), "start": start, "end": end, "f": feat})
            used.update(feat)
        out.sort(key=lambda b: (b["end"], b["start"]))
        regions[region] = {"tz": tz, "banners": out}
        print(region, len(data.get("gachas", [])), "in timer,", len(out), "kept")
        for b in out[:40]:
            print("  ", b["id"], b["type"], time.strftime("%Y-%m-%d %H:%M", time.gmtime(b["start"])), "->",
                  time.strftime("%Y-%m-%d %H:%M", time.gmtime(b["end"])), b["name"][:70], b["f"][:6])
    table = units()
    result = {"updated": now, "regions": regions, "units": {str(i): table[i] for i in used if i in table}}
    os.makedirs("data", exist_ok=True)
    with open("data/banners.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("units", len(result["units"]), "missing", [i for i in used if i not in table][:20])


if __name__ == "__main__":
    main()
