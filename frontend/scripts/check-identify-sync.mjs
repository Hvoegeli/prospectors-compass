#!/usr/bin/env node
/**
 * Drift guard for the shared specimen-ID key.
 *
 * The desktop reuses the phone's matcher + dataset via self-contained COPIES
 * (two bundlers — Metro for mobile, Vite for desktop — make cross-importing one
 * app's source tree into the other fragile). Copies can silently drift; this makes
 * drift LOUD. Mobile is the source of truth.
 *
 *   - minerals.json must be byte-identical across the two apps.
 *   - identification.ts must be identical EXCEPT the one JSON import path line
 *     (desktop keeps the dataset in src/, mobile in assets/).
 *
 * Run via `npm run check:identify-sync` (fails non-zero on drift).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..') // frontend/scripts -> repo root
const P = {
  mobileData: resolve(repo, 'mobile/assets/minerals.json'),
  desktopData: resolve(repo, 'frontend/src/minerals.json'),
  mobileSrc: resolve(repo, 'mobile/src/identification.ts'),
  desktopSrc: resolve(repo, 'frontend/src/identification.ts'),
}

const problems = []

// 1) Dataset must be byte-identical.
const mData = readFileSync(P.mobileData, 'utf8')
const dData = readFileSync(P.desktopData, 'utf8')
if (mData !== dData) {
  problems.push(
    'minerals.json differs between mobile/assets and frontend/src.\n' +
      '     Fix: cp mobile/assets/minerals.json frontend/src/minerals.json (mobile is source of truth).',
  )
}

// 2) Matcher logic must match, ignoring only the JSON import specifier and the
//    desktop-only "synced copy" note comment. Normalize both, then compare.
function normalizeSrc(text) {
  return text
    // collapse the minerals.json import to a canonical token (path differs by design)
    .replace(/import\s+mineralsData\s+from\s+'[^']*minerals\.json'/, "import mineralsData from '<JSON>'")
    // drop the desktop-only provenance note (3 leading comment lines added on the copy)
    .replace(/\n\/\/ NOTE: this file is a synced copy[\s\S]*?check:identify-sync` fails if the logic drifts\.\n/, '\n')
    .trim()
}
const mSrc = normalizeSrc(readFileSync(P.mobileSrc, 'utf8'))
const dSrc = normalizeSrc(readFileSync(P.desktopSrc, 'utf8'))
if (mSrc !== dSrc) {
  // find the first differing line for a helpful pointer
  const a = mSrc.split('\n')
  const b = dSrc.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  problems.push(
    'identification.ts logic differs between mobile and frontend.\n' +
      `     First difference near normalized line ${i + 1}:\n` +
      `       mobile : ${JSON.stringify(a[i] ?? '<eof>')}\n` +
      `       desktop: ${JSON.stringify(b[i] ?? '<eof>')}\n` +
      '     Fix: re-sync from mobile (source of truth), keeping only the JSON import path change.',
  )
}

if (problems.length) {
  console.error(`❌ identify-sync: ${problems.length} drift problem(s):\n`)
  for (const p of problems) console.error('  - ' + p + '\n')
  process.exit(1)
}
console.log('✅ identify-sync: mobile and desktop specimen-ID key are in sync.')
