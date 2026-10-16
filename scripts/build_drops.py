"""Builds data/drops.json: where each material drops (main-story free quests) with drop rates.
Drop data is player-reported (Rayshift via Atlas Academy). Heavy: refreshed weekly."""
import json
import os
import re
import sys
import time
import urllib.request

API = "https://api.atlasacademy.io"
MIN_RUNS = 30
TOP_PER_ITEM = 12


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fgo-codex-drops"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(3 + attempt * 5)


JP_CHARS = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]")


def war_title(war):
    for k in ("name", "longName"):
        v = (war.get(k) or "").replace("\n", " ").strip()
        if v and v != "-":
            return v
    return ""


def load_names():
    """quest id -> {name, spot, war, jname, jspot, jwar}: English (NA, Atlas, or our own table) + Japanese."""
    with open(os.path.join(os.path.dirname(__file__), "names_en.json"), encoding="utf-8") as f:
        manual = json.load(f)
    names = {}

    def walk(wars, keys):
        for war in wars:
            wname = war_title(war)
            for spot in war.get("spots", []):
                for q in spot.get("quests", []):
                    d = names.setdefault(q["id"], {})
                    for k, v in zip(keys, (q.get("name", ""), spot.get("name", ""), wname)):
                        if not v:
                            continue
                        if k.startswith("j") or not JP_CHARS.search(v):
                            d[k] = v            # Japanese, or a real English name: later sources win
                        else:
                            d.setdefault(k, v)  # untranslated text only as a last resort
    # order matters: NA official names win over Atlas machine names
    walk(get(f"{API}/export/JP/nice_war.json"), ("jname", "jspot", "jwar"))
    walk(get(f"{API}/export/JP/nice_war_lang_en.json"), ("name", "spot", "war"))
    try:
        walk(get(f"{API}/export/NA/nice_war.json"), ("name", "spot", "war"))
    except Exception as e:  # noqa: BLE001
        print("NA names unavailable", e)
    for qid, (qn, sp) in manual["quests"].items():
        d = names.setdefault(int(qid), {})
        if not d.get("name") or JP_CHARS.search(d["name"]):
            d["name"] = qn
        if not d.get("spot") or JP_CHARS.search(d["spot"]):
            d["spot"] = sp
    return names, manual["wars"]


def apply_names(quests, names, wars_en):
    for q in quests:
        d = names.get(q["id"], {})
        for k in ("name", "spot", "war", "jname", "jspot", "jwar"):
            if d.get(k):
                q[k] = d[k]
        if not q.get("war") or q["war"] == "-" or JP_CHARS.search(q["war"]):
            fallback = q.get("war", "")
            q["war"] = wars_en.get(str(q["warId"]), "" if fallback == "-" else fallback)


def main():
    path = "data/drops.json"
    names, wars_en = load_names()
    if os.path.exists(path) and "--force" not in sys.argv:
        age_days = 99
        try:
            with open(path, encoding="utf-8") as f:
                old = json.load(f)
            age_days = (time.time() - old.get("ts", 0)) / 86400
        except Exception:  # noqa: BLE001
            old = None
        if old and age_days < 6.5:
            apply_names(old["quests"], names, wars_en)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(old, f, ensure_ascii=False, separators=(",", ":"))
            print(f"drops.json is {age_days:.1f} days old: names refreshed only")
            return

    wars = get(f"{API}/export/JP/nice_war_lang_en.json")
    quests = []
    for war in wars:
        if war.get("eventId", 0) or war["id"] >= 8000:
            continue
        for spot in war.get("spots", []):
            for q in spot.get("quests", []):
                if q.get("type") != "free" or q.get("consumeType") not in ("ap", "apAndItem"):
                    continue
                phases = q.get("phases") or []
                if not phases:
                    continue
                quests.append({
                    "id": q["id"], "phase": max(phases), "name": q.get("name", ""),
                    "spot": spot.get("name", ""), "war": war_title(war), "warId": war["id"],
                    "ap": q.get("consume", 0),
                })
    apply_names(quests, names, wars_en)
    print(f"free quests: {len(quests)}")

    out_quests = []
    by_item = {}
    for n, q in enumerate(quests):
        try:
            ph = get(f"{API}/nice/JP/quest/{q['id']}/{q['phase']}?lang=en")
        except Exception as e:  # noqa: BLE001
            print("skip", q["id"], e)
            continue
        drops = ph.get("drops") or []
        runs = max((d.get("runs", 0) for d in drops), default=0)
        if runs < MIN_RUNS:
            continue
        qi = len(out_quests)
        out_quests.append({k: q[k] for k in ("id", "name", "spot", "war", "warId", "ap", "jname", "jspot", "jwar") if k in q} | {"runs": runs})
        rates = {}
        for d in drops:
            if d.get("type") != "item":
                continue
            rate = d.get("dropExpected")
            if rate is None and d.get("runs"):
                rate = d.get("num", 1) * d.get("dropCount", 0) / d["runs"]
            rates[d["objectId"]] = rates.get(d["objectId"], 0) + (rate or 0)
        for item_id, rate in rates.items():
            if rate > 0:
                by_item.setdefault(str(item_id), []).append([qi, round(rate, 4)])
        if n % 50 == 0:
            print(f"{n}/{len(quests)}")
        time.sleep(0.15)

    # keep the best places per item (lowest AP per drop)
    for item_id, lst in by_item.items():
        lst.sort(key=lambda x: out_quests[x[0]]["ap"] / x[1])
        by_item[item_id] = lst[:TOP_PER_ITEM]
    used = sorted({qi for lst in by_item.values() for qi, _ in lst})
    remap = {old: new for new, old in enumerate(used)}
    result = {
        "ts": int(time.time()),
        "updated": time.strftime("%Y-%m-%d"),
        "quests": [out_quests[i] for i in used],
        "items": {k: [[remap[qi], r] for qi, r in v] for k, v in by_item.items()},
    }
    os.makedirs("data", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(result['quests'])} quests, {len(result['items'])} items")


if __name__ == "__main__":
    main()
