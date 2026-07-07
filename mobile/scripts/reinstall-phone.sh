#!/usr/bin/env bash
#
# reinstall-phone.sh — rebuild + install "Compass Field" onto the connected iPhone,
# refreshing its 7-day signing so it works in the field.
#
# WHY THIS EXISTS: the app is a free-Apple-account development build. Free accounts
# get a provisioning profile that EXPIRES AFTER 7 DAYS; once it lapses, iOS shows
# "'Compass Field' is no longer available" and won't launch it — and it can't be
# revived without a computer + internet (i.e. not in the backcountry).
#
# So: **run this before every trip.** It gives a fresh 7-day window from right now.
#   - Covers any trip up to 7 days after you run it.
#   - A single trip LONGER than 7 days would still lapse mid-trip — the only fix for
#     that is a paid Apple Developer account (1-year profiles).
#
# A plain `expo run:ios` does NOT work once the profile has expired: it doesn't pass
# `-allowProvisioningUpdates`, so xcodebuild refuses to mint a new profile and fails
# with "No profiles were found". This script passes that flag, so a fresh profile is
# generated automatically, then installs the build with devicectl.
#
# Requirements: iPhone connected + unlocked, signed into the same Apple ID in Xcode,
# and the Mac online (to mint the profile).
set -euo pipefail

cd "$(dirname "$0")/.."   # -> mobile/

WORKSPACE="ios/CompassField.xcworkspace"
SCHEME="CompassField"
DERIVED="ios/build"
APP="$DERIVED/Build/Products/Debug-iphoneos/CompassField.app"

if [ ! -d "$WORKSPACE" ]; then
  echo "No native iOS project found. Run 'npx expo prebuild -p ios' first." >&2
  exit 1
fi

# Auto-detect the first connected physical iPhone's UDID (format: 8hex-16hex).
UDID="$(xcrun xctrace list devices 2>/dev/null \
  | sed -n '/== Devices ==/,/== Simulators ==/p' \
  | grep -iE 'iphone' \
  | grep -oE '\([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\)' | tr -d '()' | head -1)"

if [ -z "${UDID:-}" ]; then
  echo "No connected iPhone found. Plug it in, unlock it, and tap 'Trust', then retry." >&2
  exit 1
fi
echo "==> iPhone: $UDID"

echo "==> Building + minting a fresh provisioning profile (this takes a few minutes)…"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphoneos \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  -quiet \
  build

echo "==> Installing onto the iPhone…"
xcrun devicectl device install app --device "$UDID" "$APP"

echo ""
echo "✅ Compass Field reinstalled. Good for ~7 days (until the profile expires)."
echo "   Run this again before your next trip."
