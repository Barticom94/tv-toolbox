# TV Toolbox

An app store for the family's Android TVs. It lists a few apps we use, installs them, and keeps them up to date. A GitHub Action rebuilds the catalogue every hour from `apps.json` and publishes it on GitHub Pages; the TV app only reads that one file.

## Installing it

On the TV, open Downloader and type the code **4236218**. Or type the full address:

    https://github.com/Barticom94/tv-toolbox/releases/download/toolbox/tv-toolbox.apk

Both always serve the newest TV Toolbox. The code is an AFTVnews short link (aftv.news/4236218) to that address.

## Adding an app

Add one entry to `apps.json`:

- `id`: short lower-case name, unique.
- `name` and `blurb`: what the TV shows.
- `package`: the app's package name. The Action checks it against the APK and refuses the app if it differs.
- `hidden` (optional): `true` to keep it out of the main list.
- `replaces` (optional): older package names to uninstall when this app is installed.
- `signer` (optional): pin the signing certificate. Otherwise the first one seen is trusted.
- `source`: where the APK comes from, one of:
  - `{ "type": "github", "repo": "owner/name", "channel": "stable" | "beta", "asset": "<regex>" }`, optionally with `tag` (one fixed release) or `tagPrefix` (releases whose tag starts with it).
  - `{ "type": "folder", "url": "https://.../", "asset": "<regex>" }` for a plain web directory listing.

Push to `main` and the catalogue rebuilds on its own.

## If the catalogue stops updating

GitHub turns off a scheduled workflow when the repository has had no activity for 60 days. Open the Actions tab, choose "Catalogue", press "Enable workflow", then "Run workflow" to rebuild the catalogue straight away.

## Licences

The font (Atkinson Hyperlegible Next) is under the SIL Open Font Licence; its licence file sits next to it in `assets/ui/fonts`. The ADB library will be BSD-3-Clause once it is added.
