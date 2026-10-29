#!/bin/bash
# TV Toolbox build: aapt2 -> javac -> d8 -> zipalign -> apksigner. No Gradle (same pipeline as the other TV apps).
# Usage (Git Bash):  bash "/e/TV Toolbox/build.sh" [install|release]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK=/e/Android/sdk
BT=$SDK/build-tools/35.0.0
AJAR=$SDK/platforms/android-35/android.jar
JDK=$(ls -d /e/Android/jdk-17*/ | head -1)
export JAVA_HOME="$JDK" PATH="$JDK/bin:$PATH"
PY=/c/Python314/python

cd "$ROOT"
VC=$(( $(cat versionCode 2>/dev/null || echo 0) + 1 )); echo $VC > versionCode
B=build; rm -rf $B; mkdir -p $B/gen $B/classes $B/dex

"$BT/aapt2.exe" compile --dir res -o $B/res.zip
"$BT/aapt2.exe" link -o $B/unsigned.apk -I "$AJAR" --manifest AndroidManifest.xml -A assets $B/res.zip \
  --java $B/gen --min-sdk-version 28 --target-sdk-version 34 --version-code $VC --version-name "1.0.$VC" --auto-add-overlay
javac --release 11 -encoding UTF-8 -Xlint:-options -classpath "$AJAR" -d $B/classes $(find src $B/gen -name '*.java')
"$BT/d8.bat" --release --min-api 28 --lib "$AJAR" --output $B/dex $(find $B/classes -name '*.class')
$PY -c "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED); z.write(sys.argv[2],'classes.dex'); z.close()" \
  "$ROOT/$B/unsigned.apk" "$ROOT/$B/dex/classes.dex"
"$BT/zipalign.exe" -p -f 4 $B/unsigned.apk $B/aligned.apk
"$BT/apksigner.bat" sign --ks keystore/release.jks --ks-pass file:keystore/pass.txt --out $B/tv-toolbox.apk $B/aligned.apk
"$BT/apksigner.bat" verify $B/tv-toolbox.apk
echo "BUILD OK: versionCode $VC, $(stat -c %s $B/tv-toolbox.apk) bytes"

if [ "${1:-}" = "install" ]; then
  TV=${TV:?set TV=<ip>:5555 to install}                # not kept in the repo
  adb connect $TV >/dev/null
  adb -s $TV install -r "$ROOT/$B/tv-toolbox.apk"
  adb -s $TV shell am start -n local.adam.tvtoolbox/.MainActivity
elif [ "${1:-}" = "release" ]; then                    # the permanent toolbox URL serves this asset; the Action then refreshes the catalogue
  gh release upload toolbox "$ROOT/$B/tv-toolbox.apk" --clobber -R Barticom94/tv-toolbox
  gh workflow run catalog.yml -R Barticom94/tv-toolbox
fi
