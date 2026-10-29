"""Catalogue builder for TV Toolbox: which release and files to offer, what an APK must be, how catalog.json is put together.
The rules are pure functions: everything that touches the network or runs a tool comes in through `fetch`. `Fetch` and `main` at the end are that I/O."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from urllib.parse import quote, unquote, urlsplit

PAGES = "https://barticom94.github.io/tv-toolbox"
ABI_ORDER = ("armeabi-v7a", "universal")  # armeabi-v7a first: it is what the TVs install, and it supplies the entry's versionCode
FORMAT = 2  # entries from a catalogue of another format are read again (format 1 had minSdk 1 everywhere); pins still carry over


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

    min_sdk = sdk("minSdkVersion", sdk("sdkVersion", 1))  # aapt2 prints minSdkVersion, aapt v1 sdkVersion; 1 is Android's own default
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
    rel = choose_release(fetch.releases(src["repo"], src.get("tag")), src)
    got = pick_files(rel["assets"], src["asset"]) if rel else {}
    files = [(abi, got[abi]["browser_download_url"], f"{got[abi]['id']}:{got[abi]['updated_at']}") for abi in ABI_ORDER if abi in got]
    return rel["published_at"] if rel else "", files


def _make_entry(app: dict, old: dict | None, fetch, now: str, reuse: bool = True) -> tuple[dict, bytes | None]:
    published, files = _files_on_offer(app, fetch, now)
    if not files:
        raise ValueError("no file matches")
    pin = (app.get("signer") or "").lower() or (old or {}).get("signer")  # parse_certs lowercases, so the pin must be lowercase too
    unchanged = reuse and old and old.get("package") == app["package"] and pin == old.get("signer") and \
        [(f.get("abi"), f.get("key")) for f in old.get("files", [])] == [(abi, key) for abi, _, key in files]
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
    olds, reuse = {e["id"]: e for e in prev.get("apps", [])}, prev.get("format") == FORMAT
    out, icons, errors = [], {}, []
    for app in apps:
        old = olds.get(app["id"])
        try:
            entry, png = _make_entry(app, old, fetch, now, reuse)
        except Exception as e:  # one bad source must not take the others down; the old entry stays live
            errors.append(f"{app['id']}: {e if isinstance(e, ValueError) else repr(e)}")
            entry, png = _carry(app, old, fetch) if old else (None, None)
        if entry:
            out.append(entry)
        if png is not None:
            icons[app["id"]] = png
    return {"generated": now, "format": FORMAT, "apps": out}, icons, errors


TIMEOUT = 60  # seconds per network operation; the workflow's 30 minutes ends anything that crawls
APPS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "apps.json")


class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise ValueError("refusing a redirect to a non-HTTPS address")
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new and urlsplit(newurl).hostname != urlsplit(req.full_url).hostname:
            new.headers.pop("Authorization", None)  # the token never follows a redirect to another host
        return new


def _open(url: str, headers: dict | None = None):
    """GET over HTTPS only, redirects included. The caller closes the response."""
    if not url.lower().startswith("https://"):
        raise ValueError(f"not an HTTPS address: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tv-toolbox-catalog", **(headers or {})})
    return urllib.request.build_opener(_HttpsOnly).open(req, timeout=TIMEOUT)


def _get(url: str, headers: dict | None = None) -> bytes:
    with _open(url, headers) as r:
        return r.read()


def _icon_png(path: str, name: str) -> bytes | None:
    try:
        with zipfile.ZipFile(path) as z:
            data = z.read(name)
    except (KeyError, zipfile.BadZipFile):
        return None
    return data if data.startswith(b"\x89PNG\r\n\x1a\n") else None


class Fetch:
    """The network and the SDK tools, as `build` wants them. Only `releases` carries GITHUB_TOKEN, and only to api.github.com."""

    def __init__(self):
        tools = os.environ.get("BUILD_TOOLS", "")
        self.aapt2, self.apksigner = shutil.which("aapt2", path=tools), shutil.which("apksigner", path=tools)
        self.catalog_url = os.environ.get("CATALOG_URL", f"{PAGES}/catalog.json")

    def releases(self, repo: str, tag: str | None = None) -> list[dict]:
        """The newest 30 releases (GitHub lists newest first), or for a fixed tag just that one, which never drops off that page."""
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        if os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
        url = f"https://api.github.com/repos/{repo}/releases" + (f"/tags/{quote(tag, safe='')}" if tag else "?per_page=30")
        try:
            got = json.loads(_get(url, headers))
        except urllib.error.HTTPError as e:
            if tag and e.code == 404:
                return []  # no release with that tag
            raise ValueError(f"GitHub answered {e.code} {e.reason} for {repo}") from None
        return [got] if tag else got

    def listing(self, url: str) -> str:
        return _get(url).decode("utf-8", "replace")

    def read(self, url: str) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path, digest, size = os.path.join(tmp, "app.apk"), hashlib.sha256(), 0
            with _open(url) as r, open(path, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            run = lambda *cmd: subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            info = parse_badging(run(self.aapt2, "dump", "badging", path).stdout)
            signed = run(self.apksigner, "verify", "--print-certs", path)
            if signed.returncode:
                raise ValueError("not a valid signed APK")
            return {**info, "signer": parse_certs(signed.stdout), "size": size, "sha256": digest.hexdigest(),
                    "icon_png": _icon_png(path, info["icon"]) if info["icon"] else None}

    def prev_icon(self, id: str) -> bytes | None:
        try:
            return _get(self.catalog_url.rsplit("/", 1)[0] + f"/icons/{id}.png")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise  # build() lets this abort the run: a catalogue that silently lost its icons must not be deployed

    def previous(self) -> dict:
        """The catalogue now live. Only a 404 (none yet) starts from empty. Anything else that fails, including a 200 that isn't
        a catalogue, raises: main then stops before writing, so a bad Pages answer can never drop the signer pins."""
        try:
            got = json.loads(_get(self.catalog_url))  # bad JSON or bytes raise ValueError (JSONDecodeError, UnicodeDecodeError)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            return {"apps": []}
        if not (isinstance(got, dict) and isinstance(got.get("apps"), list)):
            raise ValueError("the live catalogue has no apps list")
        return got


def plan(apps: list[dict], fetch) -> None:
    """One line per app: what the next build would offer. Downloads nothing."""
    for app in apps:
        try:
            _, files = _files_on_offer(app, fetch, "")
            if not files:
                raise ValueError("no file matches")
            tag = unquote(files[0][1].split("/")[-2])  # the release tag, or the folder's name
            print(app["id"], tag, *(f"{abi}={unquote(url.rsplit('/', 1)[1])}" for abi, url, _ in files))
        except Exception as e:
            print(app["id"], "ERROR", e if isinstance(e, ValueError) else repr(e))


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        sys.exit("usage: build_catalog.py OUT_DIR | --plan")
    with open(APPS_JSON, encoding="utf-8") as f:
        apps = json.load(f)["apps"]
    fetch = Fetch()
    if argv[0] == "--plan":
        return plan(apps, fetch)
    if not (fetch.aapt2 and fetch.apksigner):
        sys.exit("aapt2 and apksigner not found: set BUILD_TOOLS to an Android build-tools folder")
    catalog, icons, errors = build(apps, fetch.previous(), fetch)  # any exception here ends the run before anything is written
    os.makedirs(os.path.join(argv[0], "icons"), exist_ok=True)
    for id, png in icons.items():
        with open(os.path.join(argv[0], "icons", id + ".png"), "wb") as f:
            f.write(png)
    with open(os.path.join(argv[0], "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")
    with open("errors.txt", "w", encoding="utf-8") as f:
        f.writelines(line + "\n" for line in errors)
    print(f"{len(catalog['apps'])} apps, {len(icons)} icons, {len(errors)} errors")


if __name__ == "__main__":
    main(sys.argv[1:])
