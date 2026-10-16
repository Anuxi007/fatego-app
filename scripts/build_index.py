"""Builds data/index.json: NA availability and Noble Phantasm card/target per servant.

Runs in GitHub Actions (the full Atlas export is too large to download on a phone).
"""
import json
import re
import os
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


JA_RE = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]")


def collect_strings(servants, out):
    """Unique texts that the app shows: skill/NP/passive descriptions, buff names, popup texts."""
    def add(text):
        if isinstance(text, str):
            text = text.strip()
            if text:
                out.add(text)

    def skill_like(sk):
        add(sk.get("detail"))
        for fn in sk.get("functions") or []:
            add(fn.get("funcPopupText"))
            for b in fn.get("buffs") or []:
                add(b.get("name"))

    for s in servants:
        if s.get("collectionNo", 0) <= 0:
            continue
        for sk in s.get("skills") or []:
            skill_like(sk)
        for sk in s.get("classPassive") or []:
            skill_like(sk)
        for ap in s.get("appendPassive") or []:
            if ap.get("skill"):
                skill_like(ap["skill"])
        for np in s.get("noblePhantasms") or []:
            skill_like(np)


def main():
    os.makedirs("data", exist_ok=True)
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
    # Texts to translate: English from NA, plus JP-only servants as the app shows them (lang=en)
    na_ids_set = set(na_ids)
    na_full = get(f"{API}/NA/nice_servant.json")
    jp_en = get(f"{API}/JP/nice_servant_lang_en.json")
    texts = set()
    collect_strings(na_full, texts)
    collect_strings([s for s in jp_en if s["id"] not in na_ids_set], texts)
    strings = sorted(texts)
    with open("data/strings.json", "w", encoding="utf-8") as f:
        json.dump(strings, f, ensure_ascii=False, indent=0)
    print(f"unique strings: {len(strings)} (japanese: {sum(1 for t in strings if JA_RE.search(t))})")

    # Newest servants (for "new servant" notifications)
    en = {x["id"]: x.get("name") for x in get(f"{API}/JP/basic_servant_lang_en.json")}
    playable = [x for x in jp if x.get("collectionNo", 0) > 0]
    newest = sorted(playable, key=lambda x: -x["collectionNo"])[:10]
    na_by_no = sorted([x for x in na if x.get("collectionNo", 0) > 0], key=lambda x: -x["collectionNo"])[:10]

    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "na": na_ids,
        "np": np,
        "newestJP": [{"id": x["id"], "no": x["collectionNo"], "name": en.get(x["id"]) or x.get("name")} for x in newest],
        "newestNA": [{"id": x["id"], "no": x["collectionNo"], "name": x.get("name")} for x in na_by_no],
    }
    with open("data/index.json", "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
    print(f"servants with NP: {len(np)}, NA servants: {len(na_ids)}")


if __name__ == "__main__":
    main()
