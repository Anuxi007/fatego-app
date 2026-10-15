"""Builds data/index.json: NA availability and Noble Phantasm card/target per servant.

Runs in GitHub Actions (the full Atlas export is too large to download on a phone).
"""
import json
import urllib.request
from datetime import datetime, timezone

API = "https://api.atlasacademy.io/export"
CARD = {"1": "arts", "2": "buster", "3": "quick", "arts": "arts", "buster": "buster", "quick": "quick"}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "fgo-codex-index"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def np_info(svt):
    nps = [n for n in svt.get("noblePhantasms") or [] if n.get("functions")]
    if not nps:
        return None
    # Prefer the NP marked as the strengthened/latest one (highest priority, then highest id)
    np = max(nps, key=lambda n: (n.get("priority", 0), n.get("id", 0)))
    card = CARD.get(str(np.get("card")), "buster")
    target = "support"
    for fn in np["functions"]:
        if str(fn.get("funcType", "")).startswith("damageNp"):
            target = "aoe" if fn.get("funcTargetType") == "enemyAll" else "st"
            break
    return [card, target]


def main():
    jp = get(f"{API}/JP/nice_servant.json")
    na = get(f"{API}/NA/basic_servant.json")
    na_ids = sorted({s["id"] for s in na if s.get("collectionNo", 0) > 0})
    np = {}
    for s in jp:
        if s.get("collectionNo", 0) <= 0:
            continue
        info = np_info(s)
        if info:
            np[str(s["id"])] = info
    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "na": na_ids,
        "np": np,
    }
    with open("data/index.json", "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
    print(f"servants with NP: {len(np)}, NA servants: {len(na_ids)}")


if __name__ == "__main__":
    main()
