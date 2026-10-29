"""Catalogue rules for TV Toolbox: which release and files to offer, what an APK must be, how catalog.json is put together.
Pure functions only: everything that touches the network or runs a tool comes in through `fetch`."""
import re
from datetime import datetime, timezone

PAGES = "https://barticom94.github.io/tv-toolbox"
ABI_ORDER = ("armeabi-v7a", "universal")  # armeabi-v7a first: it is what the TVs install, and it supplies the entry's versionCode


def abi_of(name: str) -> str | None:
    n = name.lower()
    if any(s in n for s in ("armeabi-v7a", "arm32v7", "armv7")):
        return "armeabi-v7a"
    if any(s in n for s in ("arm64", "aarch64", "x86", "x64")):
        return None
    return "universal"


def pick_files(assets: list[dict], pattern: str) -> dict[str, dict]:
    got = {}
    for asset in assets:
        abi = abi_of(asset["name"])
        if abi and re.search(pattern, asset["name"]):
            got.setdefault(abi, asset)
    return got


def choose_release(releases: list[dict], source: dict) -> dict | None:
    rels = [r for r in releases if not r["draft"]]
    if "tag" in source:
        rels = [r for r in rels if r["tag_name"] == source["tag"]]
    if "tagPrefix" in source:
        rels = [r for r in rels if r["tag_name"].startswith(source["tagPrefix"])]
    if source.get("channel", "stable") == "stable":
        rels = [r for r in rels if not r["prerelease"]]
    for r in sorted(rels, key=lambda r: r["published_at"], reverse=True):
        if pick_files(r["assets"], source["asset"]):
            return r
    return None


def _version(name: str) -> tuple:
    m = re.search(r"\d+(?:\.\d+)+", name)
    return tuple(int(n) for n in m.group().split(".")) if m else ()


def folder_pick(listing: str, pattern: str) -> list[str]:
    names = [h for h in re.findall(r"""href=["']([^"']+)["']""", listing) if re.search(pattern, h)]
    top = max(map(_version, names), default=())
    return [n for n in names if _version(n) == top]


def parse_badging(text: str) -> dict:
    pkg = re.search(r"^package: (.*)$", text, re.M)
    if not pkg:
        raise ValueError("not a valid APK (no package line)")
    at = dict(re.findall(r"(\w+)='([^']*)'", pkg.group(1)))

    def sdk(key, default):
        m = re.search(rf"^{key}:'(\d+)'", text, re.M)
        return int(m.group(1)) if m else default

    min_sdk = sdk("sdkVersion", 1)  # Android's own defaults when the manifest says nothing
    icons = [(int(d), p) for d, p in re.findall(r"^application-icon-(\d+):'([^']*)'", text, re.M) if p.endswith(".png")]
    return {"package": at["name"], "versionCode": int(at["versionCode"]), "versionName": at["versionName"],
            "minSdk": min_sdk, "targetSdk": sdk("targetSdkVersion", min_sdk), "icon": max(icons)[1] if icons else None}


def parse_certs(text: str) -> str:
    m = re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f]+)", text)
    if not m:
        raise ValueError("not a valid signed APK (no signer certificate)")
    return m.group(1).lower()


def check_apk(info: dict, entry: dict, pin: str | None) -> str | None:
    if info["package"] != entry["package"]:
        return f"package {info['package']} is not {entry['package']}"
    if pin and info["signer"] != pin:
        return f"signer changed from {pin} to {info['signer']}"
    if info["targetSdk"] < 23:
        return f"targetSdk {info['targetSdk']} is below 23"
    return None


def _head(app: dict, png: bytes | None) -> dict:
    """The fields apps.json owns, in catalogue order; the icon is listed only when its PNG will be on Pages."""
    head = {"id": app["id"], "name": app["name"], "blurb": app["blurb"]}
    if png is not None:
        head["icon"] = f"{PAGES}/icons/{app['id']}.png"
    return {**head, "package": app["package"], "hidden": app.get("hidden", False), "replaces": app.get("replaces", [])}


def _carry(app: dict, old: dict, fetch) -> tuple[dict, bytes | None]:
    """The entry already published, with apps.json edits applied. Each Pages deploy replaces the whole site, so the icon is fetched back too."""
    png = fetch.prev_icon(app["id"])
    entry = {**old, **_head(app, png)}
    entry["package"] = old.get("package", entry["package"])  # a refused package change must not relabel the old files
    if png is None:
        entry.pop("icon", None)
    return entry, png


def _files_on_offer(app: dict, fetch, now: str) -> tuple[str, list[tuple[str, str, str]]]:
    """(published, [(abi, url, key)]) for the newest matching release, or the highest version in the folder."""
    src = app["source"]
    if src["type"] == "folder":
        if not src["url"].endswith("/"):
            raise ValueError("folder url must end with /")
        names = folder_pick(fetch.listing(src["url"]), src["asset"])
        got = pick_files([{"name": n} for n in names], src["asset"])
        files = [(abi, src["url"] + got[abi]["name"], got[abi]["name"]) for abi in ABI_ORDER if abi in got]
        return now, files  # a folder has no release date: the first run that sees the file stamps it
    rel = choose_release(fetch.releases(src["repo"]), src)
    got = pick_files(rel["assets"], src["asset"]) if rel else {}
    files = [(abi, got[abi]["browser_download_url"], f"{got[abi]['id']}:{got[abi]['updated_at']}") for abi in ABI_ORDER if abi in got]
    return rel["published_at"] if rel else "", files


def _make_entry(app: dict, old: dict | None, fetch, now: str) -> tuple[dict, bytes | None]:
    published, files = _files_on_offer(app, fetch, now)
    if not files:
        raise ValueError("no file matches")
    pin = (app.get("signer") or "").lower() or (old or {}).get("signer")  # parse_certs lowercases, so the pin must be lowercase too
    unchanged = old and old.get("package") == app["package"] and pin == old.get("signer") and         [(f.get("abi"), f.get("key")) for f in old.get("files", [])] == [(abi, key) for abi, _, key in files]
    if unchanged:
        return _carry(app, old, fetch)
    infos = []
    # ponytail: a changed key re-reads every file, not just the changed one; per-file reuse if big in-place replacements get common
    for _, url, _ in files:
        info = fetch.read(url)
        why = check_apk(info, app, pin)
        if why:
            raise ValueError(why)
        pin = pin or info["signer"]  # trust on first use
        infos.append(info)
    png = next((i["icon_png"] for i in infos if i.get("icon_png") is not None), None)
    first = infos[0]
    return {**_head(app, png), "versionName": first["versionName"], "versionCode": first["versionCode"],
            "minSdk": first["minSdk"], "targetSdk": first["targetSdk"], "signer": pin, "published": published,
            "files": [{"abi": abi, "url": url, "size": i["size"], "sha256": i["sha256"], "key": key,
                       "versionCode": i["versionCode"], "versionName": i["versionName"]}
                      for (abi, url, key), i in zip(files, infos)]}, png


def build(apps: list[dict], prev: dict, fetch) -> tuple[dict, dict[str, bytes], list[str]]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    olds = {e["id"]: e for e in prev.get("apps", [])}
    out, icons, errors = [], {}, []
    for app in apps:
        old = olds.get(app["id"])
        try:
            entry, png = _make_entry(app, old, fetch, now)
        except Exception as e:  # one bad source must not take the others down; the old entry stays live
            errors.append(f"{app['id']}: {e if isinstance(e, ValueError) else repr(e)}")
            entry, png = _carry(app, old, fetch) if old else (None, None)
        if entry:
            out.append(entry)
        if png is not None:
            icons[app["id"]] = png
    return {"generated": now, "apps": out}, icons, errors
