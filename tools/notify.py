"""After the site is published, tell the bot owner where the new sticker is."""
import json, os, urllib.request
done = json.load(open(".done.json")) if os.path.exists(".done.json") else []
site = os.environ.get("SITE_URL", "").rstrip("/")
for d in done:
    if not d.get("chat"): continue
    word = d.get("text", "в архиве")
    text = f"{d['id']} {word}.\n{site}/#{d['id']}" if site else f"{d['id']} {word}."
    req = urllib.request.Request(f"https://api.telegram.org/bot{os.environ['TG_TOKEN']}/sendMessage",
        data=json.dumps({"chat_id": d["chat"], "text": text}).encode(), headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=20)
