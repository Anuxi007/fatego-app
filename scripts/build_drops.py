"""Builds data/drops.json: where each material drops (main-story free quests) with drop rates.
Drop data is player-reported (Rayshift via Atlas Academy). Heavy: refreshed weekly."""
import json
import os
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


def main():
    path = "data/drops.json"
    if os.path.exists(path) and "--force" not in sys.argv:
        age_days = (time.time() - os.path.getmtime(path)) / 86400
        try:
            with open(path, encoding="utf-8") as f:
                built = json.load(f).get("ts", 0)
            age_days = (time.time() - built) / 86400
        except Exception:  # noqa: BLE001
            pass
        if age_days < 6.5:
            print(f"drops.json is {age_days:.1f} days old, skipping")
            return

    wars = get(f"{API}/export/JP/nice_war_lang_en.json")
    quests = []
    for war in wars:
        if war.get("eventId", 0) or war["id"] >= 8000:
            continue
        war_name = war.get("longName") or war.get("name") or ""
        for spot in war.get("spots", []):
            for q in spot.get("quests", []):
                if q.get("type") != "free" or q.get("consumeType") not in ("ap", "apAndItem"):
                    continue
                phases = q.get("phases") or []
                if not phases:
                    continue
                quests.append({
                    "id": q["id"], "phase": max(phases), "name": q.get("name", ""),
                    "spot": spot.get("name", ""), "war": war_name, "warId": war["id"],
                    "ap": q.get("consume", 0),
                })
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
        out_quests.append({k: q[k] for k in ("id", "name", "spot", "war", "warId", "ap")} | {"runs": runs})
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
