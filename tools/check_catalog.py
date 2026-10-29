"""Self-check for build_catalog.py: python -I tools/check_catalog.py (stdlib only, exits 1 on the first failure)."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I drops the script folder from sys.path
from build_catalog import abi_of, build, check_apk, choose_release, folder_pick, parse_badging, parse_certs, pick_files


def check(fn):
    fn()
    print("PASS", fn.__name__)


def a(name, id=1):
    return {"name": name, "id": id, "updated_at": "2026-01-01T00:00:00Z",
            "browser_download_url": f"https://github.com/o/r/releases/download/t/{name}"}


def rel(tag, draft=False, pre=False, at="2026-01-01", assets=None):
    return {"tag_name": tag, "draft": draft, "prerelease": pre, "published_at": at,
            "assets": assets if assets is not None else [a(f"app_{tag}_armeabi-v7a.apk")]}


NUVIO = [a("app-full-arm64-v8a-release.apk"), a("app-full-armeabi-v7a-release.apk"),
         a("app-full-universal-release.apk"), a("app-full-x86-release.apk")]
P = r"_armeabi-v7a\.apk$"


@check
def abi_of_names():
    assert abi_of("LocalSend-1.18.2-android-arm32v7.apk") == "armeabi-v7a"
    assert abi_of("SmartTube_stable_32.68_universal.apk") == "universal"
    assert abi_of("aerial-views-1.8.5.apk") == "universal"
    assert abi_of("app-full-x86_64-release.apk") is None and abi_of("LocalSend-1.18.2-android-x64.apk") is None


@check
def pick_files_one_per_abi():
    got = pick_files(NUVIO, r"^app-full-(armeabi-v7a|universal)-release\.apk$")
    assert {k: v["name"] for k, v in got.items()} == \
        {"armeabi-v7a": "app-full-armeabi-v7a-release.apk", "universal": "app-full-universal-release.apk"}


@check
def choose_release_rules():
    # drafts never; stable skips prereleases; beta takes them; a newer release with no matching asset is skipped
    R = [rel("2.0.0", draft=True), rel("1.1.0-beta.8", pre=True, at="2026-10-22"),
         rel("latest", at="2026-10-25", assets=[a("notes.txt")]), rel("1.0.0", at="2026-09-19")]
    assert choose_release(R, {"channel": "stable", "asset": P})["tag_name"] == "1.0.0"
    assert choose_release(R, {"channel": "beta", "asset": P})["tag_name"] == "1.1.0-beta.8"
    assert choose_release(R, {"asset": P})["tag_name"] == "1.0.0"  # stable is the default
    assert choose_release([rel("songsterr-tv-1.0.34", at="2026-10-29"), rel("songsterr-tv-1.0.35", at="2026-10-30"),
                           rel("toolbox", at="2026-10-31")],
                          {"tagPrefix": "songsterr-tv-", "asset": P})["tag_name"] == "songsterr-tv-1.0.35"
    assert choose_release([rel("toolbox", at="2026-10-01"), rel("songsterr-tv-1.0.35", at="2026-10-30")],
                          {"tag": "toolbox", "asset": P})["tag_name"] == "toolbox"
    assert choose_release([rel("1.0.0", assets=[a("notes.txt")])], {"asset": P}) is None


@check
def folder_pick_highest_version():
    listing = '<a href="VLC-Android-3.7.1-armeabi-v7a.apk">x</a><a href="VLC-Android-3.7.1-armeabi-v7a.apk.sha256">x</a>' \
              '<a href="VLC-Android-3.7.1-arm64-v8a.apk">x</a><a href="VLC-Android-3.6.5-armeabi-v7a.apk">x</a>'
    assert folder_pick(listing, r"^VLC-Android-[0-9.]+-armeabi-v7a\.apk$") == ["VLC-Android-3.7.1-armeabi-v7a.apk"]


@check
def parse_badging_fields():
    B = ("package: name='com.nuvio.tv' versionCode='1062' versionName='1.0.0' platformBuildVersionName='16'\n"
         "sdkVersion:'24'\ntargetSdkVersion:'36'\napplication-icon-160:'res/a.png'\napplication-icon-320:'res/b.png'\n"
         "application-icon-65535:'res/c.xml'\n")
    assert parse_badging(B) == {"package": "com.nuvio.tv", "versionCode": 1062, "versionName": "1.0.0",
                                "minSdk": 24, "targetSdk": 36, "icon": "res/b.png"}
    assert parse_badging(B.replace("res/a.png", "res/a.xml").replace("res/b.png", "res/b.xml"))["icon"] is None


@check
def parse_certs_first_signer():
    assert parse_certs("Signer #1 certificate DN: CN=x\nSigner #1 certificate SHA-256 digest: AB12cd\n"
                       "Signer #1 certificate SHA-1 digest: ff\n") == "ab12cd"


@check
def check_apk_reasons():
    E = {"id": "nuvio", "package": "com.nuvio.tv"}
    ok = {"package": "com.nuvio.tv", "targetSdk": 36, "signer": "aa"}
    assert check_apk(ok, E, "aa") is None and check_apk(ok, E, None) is None
    assert check_apk({**ok, "package": "com.x"}, E, None) == "package com.x is not com.nuvio.tv"
    assert check_apk({**ok, "signer": "bb"}, E, "aa") == "signer changed from aa to bb"
    assert check_apk({**ok, "targetSdk": 22}, E, None) == "targetSdk 22 is below 23"


# build(): a fake fetch that counts read() calls
class Fake:
    def __init__(self, releases=None, listings=None, signer="aa", icon_png=b"PNG", prev_icons=None, versions=None,
                 package="com.nuvio.tv"):
        self._releases, self._listings, self.signer, self.icon_png = releases or {}, listings or {}, signer, icon_png
        self._prev_icons, self.versions, self.package, self.reads = prev_icons or {}, versions or {}, package, []

    def releases(self, repo):
        got = self._releases[repo]
        if isinstance(got, Exception):
            raise got
        return got

    def listing(self, url):
        return self._listings[url]

    def read(self, url):
        self.reads.append(url)
        code = self.versions.get(abi_of(url), 1062)  # versions: versionCode by ABI
        return {"package": self.package, "versionCode": code, "versionName": f"v{code}", "minSdk": 24, "targetSdk": 36,
                "icon": "res/b.png", "signer": self.signer, "size": len(url), "sha256": "h" + url[-8:],
                "icon_png": self.icon_png}

    def prev_icon(self, id):
        return self._prev_icons.get(id)


def app(id="nuvio", **more):
    return {"id": id, "name": id.title(), "blurb": "Blurb.", "package": "com.nuvio.tv",
            "source": {"type": "github", "repo": f"o/{id}", "channel": "stable",
                       "asset": r"^app-full-(armeabi-v7a|universal)-release\.apk$"}, **more}


def release(tag="1.0.0", at="2026-09-19", n=0):  # n shifts the asset ids: a new release has new assets
    return rel(tag, at=at, assets=[a("app-full-universal-release.apk", 12 + n), a("app-full-armeabi-v7a-release.apk", 11 + n),
                                   a("app-full-arm64-v8a-release.apk", 13 + n)])


ICON = "https://barticom94.github.io/tv-toolbox/icons/nuvio.png"
FIRST = Fake(releases={"o/nuvio": [release()]})
CAT, ICONS, ERRS = build([app()], {"apps": []}, FIRST)


@check
def new_release_is_read_once_per_file():
    e = CAT["apps"][0]
    assert ERRS == [] and len(FIRST.reads) == 2
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", CAT["generated"])
    assert list(e) == ["id", "name", "blurb", "icon", "package", "hidden", "replaces", "versionName", "versionCode",
                       "minSdk", "targetSdk", "signer", "published", "files"]
    assert (e["hidden"], e["replaces"], e["signer"], e["published"], e["icon"]) == (False, [], "aa", "2026-09-19", ICON)
    assert ICONS == {"nuvio": b"PNG"}
    assert [(f["abi"], f["url"], f["key"]) for f in e["files"]] == [
        ("armeabi-v7a", "https://github.com/o/r/releases/download/t/app-full-armeabi-v7a-release.apk", "11:2026-01-01T00:00:00Z"),
        ("universal", "https://github.com/o/r/releases/download/t/app-full-universal-release.apk", "12:2026-01-01T00:00:00Z")]
    assert list(e["files"][0]) == ["abi", "url", "size", "sha256", "key", "versionCode", "versionName"]


@check
def no_icon_when_the_apk_has_no_png():
    cat, icons, errs = build([app()], {"apps": []}, Fake(releases={"o/nuvio": [release()]}, icon_png=None))
    assert errs == [] and "icon" not in cat["apps"][0] and icons == {}


@check
def unchanged_asset_is_reused():
    fx = Fake(releases={"o/nuvio": [release()]}, prev_icons={"nuvio": b"PNG"})
    cat, icons, errs = build([app()], CAT, fx)
    assert fx.reads == [] and errs == [] and cat["apps"] == CAT["apps"] and icons == {"nuvio": b"PNG"}
    # a name or blurb edited in apps.json still lands, without reading anything
    cat, icons, errs = build([app(blurb="New.")], CAT, fx)
    assert fx.reads == [] and cat["apps"][0]["blurb"] == "New." and cat["apps"][0]["files"] == CAT["apps"][0]["files"]
    # the icon is gone from Pages: the card loses it too
    cat, icons, errs = build([app()], CAT, Fake(releases={"o/nuvio": [release()]}))
    assert "icon" not in cat["apps"][0] and icons == {}


@check
def signer_change_keeps_the_old_entry():
    fx = Fake(releases={"o/nuvio": [release("1.0.1", "2026-10-01", n=10)]}, signer="bb", prev_icons={"nuvio": b"PNG"})
    cat, icons, errs = build([app()], CAT, fx)
    assert cat["apps"] == CAT["apps"] and icons == {"nuvio": b"PNG"}
    assert errs == ["nuvio: signer changed from aa to bb"]


@check
def pin_in_apps_json_wins():
    cat, icons, errs = build([app(signer="cc")], {"apps": []}, Fake(releases={"o/nuvio": [release()]}))
    assert cat["apps"] == [] and icons == {} and errs == ["nuvio: signer changed from cc to aa"]
    # and a pin that matches is kept as the entry's signer
    cat, icons, errs = build([app(signer="aa")], {"apps": []}, Fake(releases={"o/nuvio": [release()]}))
    assert errs == [] and cat["apps"][0]["signer"] == "aa"


@check
def no_matching_file():
    nothing = {"o/nuvio": [rel("1.0.0", assets=[a("notes.txt")])]}
    cat, icons, errs = build([app()], {"apps": []}, Fake(releases=nothing))
    assert cat["apps"] == [] and errs == ["nuvio: no file matches"]
    cat, icons, errs = build([app()], CAT, Fake(releases=nothing, prev_icons={"nuvio": b"PNG"}))
    assert cat["apps"] == CAT["apps"] and errs == ["nuvio: no file matches"]


@check
def one_failing_source_does_not_stop_the_rest():
    fx = Fake(releases={"o/a": RuntimeError("boom"), "o/b": [release()], "o/c": [release()]})
    cat, icons, errs = build([app("a"), app("b"), app("c")], {"apps": []}, fx)
    assert [e["id"] for e in cat["apps"]] == ["b", "c"] and set(icons) == {"b", "c"}
    assert len(errs) == 1 and errs[0].startswith("a: ") and "boom" in errs[0]
    # an app that was fine before stays in the catalogue, in apps.json order
    old = {"apps": [{**CAT["apps"][0], "id": "a"}]}
    cat, icons, errs = build([app("a"), app("b")], old, Fake(releases={"o/a": RuntimeError("boom"), "o/b": [release()]}))
    assert [e["id"] for e in cat["apps"]] == ["a", "b"] and len(errs) == 1


@check
def hidden_and_replaces_pass_through():
    cat, icons, errs = build([app(hidden=True, replaces=["x.y", "z.w"])], {"apps": []}, Fake(releases={"o/nuvio": [release()]}))
    assert (cat["apps"][0]["hidden"], cat["apps"][0]["replaces"]) == (True, ["x.y", "z.w"])


@check
def each_file_carries_its_own_version():
    fx = Fake(releases={"o/nuvio": [release()]}, versions={"armeabi-v7a": 100, "universal": 101})
    cat, icons, errs = build([app()], {"apps": []}, fx)
    e = cat["apps"][0]
    assert errs == []
    assert [(f["abi"], f["versionCode"], f["versionName"]) for f in e["files"]] == [("armeabi-v7a", 100, "v100"), ("universal", 101, "v101")]
    assert (e["versionCode"], e["versionName"]) == (100, "v100")  # the entry itself takes the first file's


@check
def new_release_replaces_the_old_entry():
    fx = Fake(releases={"o/nuvio": [release("1.0.1", "2026-10-01", n=10)]}, versions={"armeabi-v7a": 200, "universal": 201})
    cat, icons, errs = build([app()], CAT, fx)
    e = cat["apps"][0]
    assert errs == [] and len(fx.reads) == 2 and len(cat["apps"]) == 1
    assert (e["versionCode"], e["published"], e["signer"]) == (200, "2026-10-01", "aa")
    assert [f["key"] for f in e["files"]] == ["21:2026-01-01T00:00:00Z", "22:2026-01-01T00:00:00Z"]
    assert icons == {"nuvio": b"PNG"}


@check
def pin_comparison_ignores_case():
    cat, icons, errs = build([app(signer="AA")], {"apps": []}, Fake(releases={"o/nuvio": [release()]}))
    assert errs == [] and cat["apps"][0]["signer"] == "aa"
    fx = Fake(releases={"o/nuvio": [release()]}, prev_icons={"nuvio": b"PNG"})
    cat, icons, errs = build([app(signer="AA")], CAT, fx)
    assert fx.reads == [] and errs == [] and cat["apps"] == CAT["apps"]


@check
def pin_differing_from_the_old_signer_is_re_read_and_refused():
    fx = Fake(releases={"o/nuvio": [release()]}, prev_icons={"nuvio": b"PNG"})  # same file keys as CAT
    cat, icons, errs = build([app(signer="cc")], CAT, fx)
    assert len(fx.reads) == 1 and errs == ["nuvio: signer changed from cc to aa"] and cat["apps"] == CAT["apps"]


@check
def old_entry_without_file_keys_is_read_again():
    bare = {"apps": [{**CAT["apps"][0], "files": [{k: v for k, v in f.items() if k != "key"} for f in CAT["apps"][0]["files"]]}]}
    fx = Fake(releases={"o/nuvio": [release()]})
    cat, icons, errs = build([app()], bare, fx)
    assert len(fx.reads) == 2 and errs == [] and cat["apps"] == CAT["apps"]


@check
def changed_package_is_read_again():
    fx = Fake(releases={"o/nuvio": [release()]}, package="com.nuvio.tv2")
    cat, icons, errs = build([app(package="com.nuvio.tv2")], CAT, fx)
    assert len(fx.reads) == 2 and errs == [] and cat["apps"][0]["package"] == "com.nuvio.tv2"
    # the APK still says com.nuvio.tv: refused, and the kept entry keeps the package its files really have
    fx = Fake(releases={"o/nuvio": [release()]}, prev_icons={"nuvio": b"PNG"})
    cat, icons, errs = build([app(package="com.other")], CAT, fx)
    assert len(fx.reads) == 1 and errs == ["nuvio: package com.nuvio.tv is not com.other"] and cat["apps"] == CAT["apps"]


def folder_app(url):
    return {"id": "vlc", "name": "VLC", "blurb": "Plays.", "package": "com.nuvio.tv",
            "source": {"type": "folder", "url": url, "asset": r"^VLC-Android-[0-9.]+-armeabi-v7a\.apk$"}}


@check
def folder_url_must_end_with_a_slash():
    fx = Fake()  # listing() would raise KeyError if it were called
    cat, icons, errs = build([folder_app("https://dl.example/vlc")], {"apps": []}, fx)
    assert cat["apps"] == [] and errs == ["vlc: folder url must end with /"] and fx.reads == []


@check
def folder_source_uses_the_file_name_as_key():
    url = "https://dl.example/vlc/"
    listing = '<a href="VLC-Android-3.7.1-armeabi-v7a.apk">x</a><a href="VLC-Android-3.6.5-armeabi-v7a.apk">x</a>'
    vlc = folder_app(url)
    fx = Fake(listings={url: listing})
    cat, icons, errs = build([vlc], {"apps": []}, fx)
    f = cat["apps"][0]["files"]
    assert errs == [] and len(f) == 1 and f[0]["abi"] == "armeabi-v7a"
    assert f[0]["key"] == "VLC-Android-3.7.1-armeabi-v7a.apk" and f[0]["url"] == url + f[0]["key"]
    fx = Fake(listings={url: listing}, prev_icons={"vlc": b"PNG"})
    again, icons, errs = build([vlc], cat, fx)
    assert fx.reads == [] and again["apps"] == cat["apps"]
