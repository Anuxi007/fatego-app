"""Builds data/daily.json: Chaldea Gate daily quests (Training Grounds, Ember Gathering)
with drop rates from Atlas Academy (player-reported data)."""
import json
import os
import re
import time
import urllib.request

API = "https://api.atlasacademy.io"
DAYS = {"月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6, "日": 7}
CLASSES = {"剣": "saber", "弓": "archer", "槍": "lancer", "騎": "rider",
           "術": "caster", "殺": "assassin", "狂": "berserker"}
TIERS = ["初級", "中級", "上級", "超級", "極級"]


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fgo-codex-daily"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)


def classify(name):
    day = next((v for k, v in DAYS.items() if name.startswith(k)), None)
    tier = next((i for i, t in enumerate(TIERS) if t in name), None)
    if "修練場" in name:
        cls = next((v for k, v in CLASSES.items() if k + "の修練場" in name), None)
        return day, "tg", [cls] if cls else [], tier
    if "種火集め" in name:
        m = re.search(r"<(.+?)編>", name)
        group = m.group(1) if m else ""
        classes = [v for k, v in CLASSES.items() if k in group]
        return day, "ember", classes, tier
    return day, None, [], tier


def main():
    now = int(time.time())
    war = get(f"{API}/nice/JP/war/1002")
    candidates = []
    for spot in war.get("spots", []):
        for q in spot.get("quests", []):
            name = q.get("name", "")
            if q.get("closedAt", 0) < now or q.get("openedAt", 0) > now:
                continue
            day, kind, classes, tier = classify(name)
            if not kind or day is None:
                continue
            phases = q.get("phases") or [1]
            candidates.append({
                "id": q["id"], "jp": name, "kind": kind, "day": day, "classes": classes,
                "tier": tier, "ap": q.get("consume", 0), "phase": max(phases),
            })
    print(f"current daily quests: {len(candidates)}")

    items = {}
    for it in get(f"{API}/export/NA/nice_item.json"):
        items[it["id"]] = {"name": it.get("name"), "icon": it.get("icon")}
    svt_cache = {}

    def svt_info(sid):
        if sid not in svt_cache:
            try:
                s = get(f"{API}/basic/JP/svt/{sid}?lang=en")
                svt_cache[sid] = {"name": s.get("name"), "icon": s.get("face")}
            except Exception:  # noqa: BLE001
                svt_cache[sid] = {"name": str(sid), "icon": None}
        return svt_cache[sid]

    out = []
    for c in candidates:
        try:
            phase = get(f"{API}/nice/JP/quest/{c['id']}/{c['phase']}")
        except Exception as e:  # noqa: BLE001
            print("skip", c["id"], e)
            continue
        drops = []
        runs = 0
        for d in phase.get("drops") or []:
            runs = max(runs, d.get("runs", 0))
            info = svt_info(d["objectId"]) if d.get("type") == "servant" else items.get(d["objectId"], {"name": str(d["objectId"]), "icon": None})
            rate = d.get("dropExpected")
            if rate is None and d.get("runs"):
                rate = d.get("num", 1) * d.get("dropCount", 0) / d["runs"]
            drops.append({"id": d["objectId"], "type": d.get("type"), "name": info["name"],
                          "icon": info["icon"], "num": d.get("num", 1), "rate": round(rate or 0, 4)})
        merged = {}
        for d in drops:
            k = (d["id"], d["type"])
            if k in merged:
                merged[k]["rate"] = round(merged[k]["rate"] + d["rate"], 4)
            else:
                merged[k] = d
        drops = sorted(merged.values(), key=lambda d: -d["rate"])
        out.append({**{k: c[k] for k in ("id", "jp", "kind", "day", "classes", "tier", "ap")},
                    "runs": runs, "drops": drops})
        time.sleep(0.2)

    os.makedirs("data", exist_ok=True)
    with open("data/daily.json", "w", encoding="utf-8") as f:
        json.dump({"updated": time.strftime("%Y-%m-%d"), "quests": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} quests")


if __name__ == "__main__":
    main()
