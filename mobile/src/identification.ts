/**
 * Non-AI specimen identification — a deterministic, offline property key.
 *
 * The user reports a few observed properties (color, luster, hardness band, streak,
 * magnetism, heft, how it breaks); `rankCandidates` scores every mineral in
 * assets/minerals.json and returns ranked candidates + a confidence. Per the project
 * safety rule, when confidence < 0.60 the result is `namingLocked` — we do NOT name a
 * specimen, only surface field tests to run. Hazards (arsenic/mercury/lead) are always
 * surfaced for any plausible candidate, regardless of confidence.
 */
import mineralsData from '../assets/minerals.json'

export type Heft = 'light' | 'medium' | 'heavy' | 'very_heavy'
export type Magnetic = 'no' | 'weak' | 'strong'

export interface Mineral {
  id: string
  name: string
  aliases: string[]
  hardness: [number, number]
  streak: string
  luster: string[]
  color: string[]
  magnetic: Magnetic
  heft: Heft
  cleavage?: string
  habit?: string
  hazard?: string
  field_tests: string[]
  target_tags: string[]
  note: string
}

// JSON infers looser types (e.g. number[] for the hardness tuple), so cast via unknown.
// The dataset conforms to Mineral at runtime (field shape validated in the build check).
export const MINERALS: Mineral[] = (mineralsData as unknown as { minerals: Mineral[] }).minerals

/** Below this confidence we must not name the specimen (project safety rule). */
export const NAMING_THRESHOLD = 0.6

// ── What the user can observe. All optional; each value is an option `id`. ──────────
export interface Observed {
  color?: string
  luster?: string
  hardness?: string // hardness-band id
  streak?: string // streak-bucket id
  magnetism?: string // 'magnetic' | 'nonmagnetic'
  heft?: Heft
  breakage?: string // how-it-breaks bucket id
}

export interface PropertyOption {
  id: string
  label: string
}
export interface PropertyDef {
  key: keyof Observed
  label: string
  help: string
  weight: number
  options: PropertyOption[]
}

/** Hardness bands → the Mohs range each covers (with everyday reference tests). */
const HARDNESS_BANDS: Record<string, [number, number]> = {
  very_soft: [0, 2.5], // fingernail (2.5)
  soft: [2.5, 5], // knife scratches it easily
  medium: [5, 6], // scratches glass; a file marks it
  hard: [6, 7], // scratches glass & steel
  very_hard: [7, 11], // scratches quartz
}

/** Streak buckets (what the user sees) → the mineral streak strings each matches. */
const STREAK_BUCKETS: Record<string, string[]> = {
  white: ['white'],
  gray: ['lead-gray', 'gray', 'gray-black', 'greenish-gray'],
  black: ['black', 'gray-black', 'greenish-black'],
  greenish_black: ['greenish-black'],
  reddish: ['red-brown', 'orange-red', 'scarlet', 'brownish-red'],
  gold: ['gold-yellow'],
  yellowish: ['pale yellow', 'yellow-brown', 'gold-yellow'],
  brown: ['yellow-brown', 'red-brown', 'brown'],
  green: ['green'],
  blue: ['blue'],
  silver: ['silver-white'],
}

/** "How does it break" buckets → substrings matched against cleavage + habit. */
const BREAKAGE_SUBSTR: Record<string, string[]> = {
  cubes: ['cubic', 'cube'],
  sheets: ['sheet', 'basal', 'foliated', 'flake'],
  flat_faces: ['direction', 'tabular', 'blade', 'prism'],
  rhombs: ['rhomb'],
  glassy: ['none', 'conchoidal'],
}

const HEFT_ORDER: Heft[] = ['light', 'medium', 'heavy', 'very_heavy']

export const PROPERTIES: PropertyDef[] = [
  {
    key: 'color',
    label: 'Color',
    help: 'Overall color of a fresh (unweathered) surface.',
    weight: 1,
    options: [
      { id: 'gold', label: 'Gold / brass' },
      { id: 'silver', label: 'Silver / gray' },
      { id: 'black', label: 'Black' },
      { id: 'white', label: 'White / colorless' },
      { id: 'red', label: 'Red' },
      { id: 'orange', label: 'Orange' },
      { id: 'yellow', label: 'Yellow' },
      { id: 'green', label: 'Green' },
      { id: 'blue', label: 'Blue' },
      { id: 'purple', label: 'Purple' },
      { id: 'pink', label: 'Pink' },
      { id: 'brown', label: 'Brown' },
      { id: 'clear', label: 'Clear' },
    ],
  },
  {
    key: 'luster',
    label: 'Luster (shine)',
    help: 'How the surface reflects light.',
    weight: 1.5,
    options: [
      { id: 'metallic', label: 'Metallic (like polished metal)' },
      { id: 'submetallic', label: 'Sub-metallic (dull metal)' },
      { id: 'vitreous', label: 'Glassy' },
      { id: 'resinous', label: 'Resinous / greasy (like tree sap)' },
      { id: 'adamantine', label: 'Brilliant / diamond-like' },
      { id: 'pearly', label: 'Pearly' },
      { id: 'dull', label: 'Dull / earthy' },
    ],
  },
  {
    key: 'hardness',
    label: 'Hardness',
    help: 'Scratch test. Fingernail ≈2.5, copper penny ≈3, knife/steel ≈5.5, glass ≈5.5, quartz =7.',
    weight: 3,
    options: [
      { id: 'very_soft', label: 'Very soft — fingernail scratches it (≤2.5)' },
      { id: 'soft', label: 'Soft — a knife scratches it (3–5)' },
      { id: 'medium', label: 'Medium — scratches glass, a file marks it (5–6)' },
      { id: 'hard', label: 'Hard — scratches glass & steel (6–7)' },
      { id: 'very_hard', label: 'Very hard — scratches quartz (7+)' },
    ],
  },
  {
    key: 'streak',
    label: 'Streak',
    help: 'Color of the powder when rubbed on unglazed porcelain (the back of a tile). Often different from the mineral’s color — and highly diagnostic.',
    weight: 3,
    options: [
      { id: 'white', label: 'White / colorless' },
      { id: 'gray', label: 'Gray' },
      { id: 'black', label: 'Black' },
      { id: 'greenish_black', label: 'Dark green-black' },
      { id: 'reddish', label: 'Red / red-brown' },
      { id: 'gold', label: 'Gold-yellow' },
      { id: 'yellowish', label: 'Pale yellow' },
      { id: 'brown', label: 'Brown' },
      { id: 'green', label: 'Green' },
      { id: 'blue', label: 'Blue' },
      { id: 'silver', label: 'Silver-white' },
    ],
  },
  {
    key: 'magnetism',
    label: 'Magnetism',
    help: 'Does a magnet stick to it?',
    weight: 2,
    options: [
      { id: 'magnetic', label: 'Magnetic (a magnet grabs it)' },
      { id: 'nonmagnetic', label: 'Not magnetic' },
    ],
  },
  {
    key: 'heft',
    label: 'Heft (weight for its size)',
    help: 'Heavier than it looks? Metals & mercury/lead ores feel very heavy.',
    weight: 2,
    options: [
      { id: 'light', label: 'Light' },
      { id: 'medium', label: 'Medium' },
      { id: 'heavy', label: 'Heavy' },
      { id: 'very_heavy', label: 'Very heavy (surprisingly so)' },
    ],
  },
  {
    key: 'breakage',
    label: 'How it breaks',
    help: 'Optional — the shape it breaks or cleaves into.',
    weight: 1.5,
    options: [
      { id: 'cubes', label: 'Into cubes' },
      { id: 'sheets', label: 'Peels into flexible sheets' },
      { id: 'flat_faces', label: 'Flat shiny faces / blades / prisms' },
      { id: 'rhombs', label: 'Into rhombs (leaning cubes)' },
      { id: 'glassy', label: 'No flat faces — curved break, like glass' },
    ],
  },
]

type MatchResult = 'match' | 'contradict' | 'unknown'

// Grouped chip labels must match either term in the dataset, so "Silver / gray"
// matches a mineral colored 'gray', "Gold / brass" matches 'brass', etc.
const COLOR_SYNONYMS: Record<string, string[]> = {
  silver: ['silver', 'gray'],
  gold: ['gold', 'brass'],
}
const LUSTER_SYNONYMS: Record<string, string[]> = {
  resinous: ['resinous', 'greasy'],
  dull: ['dull', 'earthy'],
}

function matchColor(opt: string, m: Mineral): MatchResult {
  const accepted = COLOR_SYNONYMS[opt] ?? [opt]
  return accepted.some((c) => m.color.includes(c)) ? 'match' : 'contradict'
}
function matchLuster(opt: string, m: Mineral): MatchResult {
  const accepted = LUSTER_SYNONYMS[opt] ?? [opt]
  return accepted.some((l) => m.luster.includes(l)) ? 'match' : 'contradict'
}
function matchHardness(opt: string, m: Mineral): MatchResult {
  const band = HARDNESS_BANDS[opt]
  if (!band) return 'unknown'
  const [lo, hi] = band
  const [mlo, mhi] = m.hardness
  return lo <= mhi && mlo <= hi ? 'match' : 'contradict' // ranges overlap
}
function matchStreak(opt: string, m: Mineral): MatchResult {
  const set = STREAK_BUCKETS[opt]
  if (!set) return 'unknown'
  return set.includes(m.streak) ? 'match' : 'contradict'
}
function matchMagnetism(opt: string, m: Mineral): MatchResult {
  if (m.magnetic === 'weak') return 'unknown' // ambiguous either way
  const mineralMagnetic = m.magnetic === 'strong'
  const userMagnetic = opt === 'magnetic'
  return mineralMagnetic === userMagnetic ? 'match' : 'contradict'
}
function matchHeft(opt: string, m: Mineral): MatchResult {
  const i = HEFT_ORDER.indexOf(opt as Heft)
  const j = HEFT_ORDER.indexOf(m.heft)
  if (i < 0 || j < 0) return 'unknown'
  const d = Math.abs(i - j)
  if (d === 0) return 'match'
  if (d === 1) return 'unknown' // adjacent — don't reward or punish
  return 'contradict'
}
function matchBreakage(opt: string, m: Mineral): MatchResult {
  const subs = BREAKAGE_SUBSTR[opt]
  if (!subs) return 'unknown'
  const hay = `${m.cleavage ?? ''} ${m.habit ?? ''}`.toLowerCase()
  return subs.some((s) => hay.includes(s)) ? 'match' : 'unknown' // absence isn't a contradiction
}

const MATCHERS: Record<keyof Observed, (opt: string, m: Mineral) => MatchResult> = {
  color: matchColor,
  luster: matchLuster,
  hardness: matchHardness,
  streak: matchStreak,
  magnetism: matchMagnetism,
  heft: matchHeft,
  breakage: matchBreakage,
}

const WEIGHT_BY_KEY: Record<keyof Observed, number> = PROPERTIES.reduce(
  (acc, p) => {
    acc[p.key] = p.weight
    return acc
  },
  {} as Record<keyof Observed, number>,
)

export interface Candidate {
  mineral: Mineral
  score: number // raw (unbiased) match score
  matched: string[] // property labels that matched
  conflicts: string[] // property labels that contradicted
}

export interface Hazard {
  id: string
  name: string
  hazard: string
}

export interface IdResult {
  candidates: Candidate[] // ranked, best first (top few)
  confidence: number // 0..1
  namingLocked: boolean // confidence < NAMING_THRESHOLD (or too little evidence)
  fieldTests: string[] // how to narrow the top candidates
  hazards: Hazard[] // toxic candidates among the top — always surfaced
  comment: string
  answeredCount: number
}

const PROP_LABEL: Record<keyof Observed, string> = PROPERTIES.reduce(
  (acc, p) => {
    acc[p.key] = p.label
    return acc
  },
  {} as Record<keyof Observed, string>,
)

/**
 * Rank minerals against the observed properties. `tripTarget` (the active trip's
 * resource, if any) applies a small bias toward minerals tagged for that target.
 */
export function rankCandidates(obs: Observed, opts?: { tripTarget?: string | null }): IdResult {
  const answeredKeys = (Object.keys(obs) as (keyof Observed)[]).filter((k) => obs[k])
  const answeredWeight = answeredKeys.reduce((s, k) => s + WEIGHT_BY_KEY[k], 0)

  const scored = MINERALS.map((mineral) => {
    let score = 0
    const matched: string[] = []
    const conflicts: string[] = []
    for (const key of answeredKeys) {
      const res = MATCHERS[key](obs[key] as string, mineral)
      const w = WEIGHT_BY_KEY[key]
      if (res === 'match') {
        score += w
        matched.push(PROP_LABEL[key])
      } else if (res === 'contradict') {
        score -= w
        conflicts.push(PROP_LABEL[key])
      }
    }
    // Soft region bias: nudge (never decide) toward the active trip's resource.
    let biased = score
    if (opts?.tripTarget && score > 0 && mineral.target_tags.includes(opts.tripTarget)) {
      biased = score * 1.15
    }
    return { mineral, score, biased, matched, conflicts }
  })

  scored.sort((a, b) => b.biased - a.biased)

  const top = scored[0]
  const second = scored[1]
  const fit = answeredWeight > 0 && top ? clamp01(top.score / answeredWeight) : 0
  const separation =
    top && top.score > 0 ? clamp01((top.score - (second?.score ?? 0)) / top.score) : 0
  let confidence = clamp01(fit * (0.55 + 0.45 * separation))
  // Not enough evidence to be sure on one or two coarse observations.
  if (answeredKeys.length < 2 || !top || top.score <= 0) confidence = 0

  const namingLocked = confidence < NAMING_THRESHOLD

  const candidates: Candidate[] = scored
    .filter((s) => s.score > 0)
    .slice(0, 4)
    .map(({ mineral, score, matched, conflicts }) => ({ mineral, score, matched, conflicts }))

  // Field tests + hazards come only from plausible (positive-score) candidates — never
  // from non-matching minerals, so we don't show a misleading hazard when nothing fits.
  const topForTests = candidates.slice(0, 3)
  const fieldTests = dedupe(topForTests.flatMap((c) => c.mineral.field_tests)).slice(0, 6)

  // Hazards: any toxic mineral among the plausible top candidates — always shown.
  const hazards: Hazard[] = topForTests
    .filter((c) => c.mineral.hazard)
    .map((c) => ({ id: c.mineral.id, name: c.mineral.name, hazard: c.mineral.hazard as string }))

  let comment: string
  if (answeredKeys.length === 0) {
    comment = 'Choose the properties you can observe to narrow it down.'
  } else if (namingLocked) {
    comment =
      candidates.length > 0
        ? 'Not confident enough to name it — several minerals fit. Run these field tests to narrow it down.'
        : 'Nothing matches those properties well. Double-check the streak and hardness, or add more observations.'
  } else {
    comment = `Most likely ${top!.mineral.name} — ${Math.round(confidence * 100)}% confidence.`
  }

  return {
    candidates,
    confidence,
    namingLocked,
    fieldTests,
    hazards,
    comment,
    answeredCount: answeredKeys.length,
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}
function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs))
}
