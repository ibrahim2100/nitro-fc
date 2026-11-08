#!/bin/sh
# Downloads the latest official Paletools and builds the Arabic / no-Snipe version.
# usage: sh tools/update.sh        (run from the project folder)
set -e
cd "$(dirname "$0")/.."
mkdir -p original out
curl -sS -L -m 60 -o original/paletools.user.js https://pale.tools/fifa/dist/latest/paletools.user.js
echo "official: $(grep -m1 '@version' original/paletools.user.js)  sha256=$(shasum -a 256 original/paletools.user.js | cut -c1-16)..."
node tools/build.js original/paletools.user.js out/paletools-ar.user.js
node tools/make-extension.js out/paletools-ar.user.js out/extension
node tools/test-extension.js out/extension
node tools/test-nitro.js
node tools/test-sbc-integration.js
(cd out && rm -f paletools-ar-extension.zip && zip -qr paletools-ar-extension.zip extension)
echo "done: out/paletools-ar.user.js  out/extension/  out/paletools-ar-extension.zip"
