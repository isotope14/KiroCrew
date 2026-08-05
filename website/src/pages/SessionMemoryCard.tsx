/**
 * Session & Task Memory — a task-manager view of "which session is using my RAM".
 *
 * The System page already answers the aggregate question (host total, gateway
 * pool, RAM saved). What it could not answer is the per-session breakdown, which
 * is the one a user actually acts on: they close a session, not a byte total.
 *
 * Shaped after Activity Monitor rather than the dashboard's usual stat cards: a
 * dense table beats N cards when the task is "find the biggest one", and per-row
 * bars turn a column of numbers into noise. Rows disclose their running tasks,
 * and clicking a session opens its chat window — the row is only useful if it
 * leads somewhere.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { MemoryStick } from 'lucide-react'
import { api } from '../api/client'
import { Card, CardTitle, EmptyState, SearchInput } from '../components/ui'
import InfoTip from '../components/InfoTip'
import { compareText, fmtDuration, fmtNumber, fmtPercent, fmtUnit, type FormatUnit } from '../i18n/format'

import { i18nT } from '../i18n/t'
type Payload = Awaited<ReturnType<typeof api.sessionsMemory>>
type SessionRow = Payload['sessions'][number]
type TaskRow = Payload['tasks'][number]

/** A display row: a session, or one of its tasks indented beneath it. */
export interface DisplayRow {
  kind: 'session' | 'task'
  id: string
  name: string
  agent: string
  rssMb: number | null
  peakMb: number | null
  cpuCores: number | null
  procs: number | null
  mcp: number | null
  uptimeS: number | null
  pid: number | null
  shared: boolean
  /** Route to open on click, or null when this row has no chat window. */
  href: string | null
}

/**
 * Route that opens a session's chat window, or null when there is none to open.
 *
 * Only dashboard sessions have a chat window. `_bg`, cron, and Slack sessions are
 * real sessions with real memory, but nothing to navigate to — returning null
 * keeps them in the table as non-interactive rows instead of shipping a click
 * that silently does nothing.
 *
 * ChatPage resolves the session from the `?sid=` query param and dispatches
 * `switchSlot` itself, so navigation alone is sufficient. The param takes the
 * BARE slot key: the `dashboard:` prefix belongs to the backend session key.
 */
export function sessionChatPath(sessionKey: string): string | null {
  if (!sessionKey.startsWith('dashboard:')) return null
  const slotKey = sessionKey.slice('dashboard:'.length)
  if (!slotKey) return null
  return `/chat?sid=${encodeURIComponent(slotKey)}`
}

/** `3238` -> `"3,238.0MB"` in the active locale; null/unsampled -> em dash. */
export function fmtMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return '—'
  return fmtUnit(mb, 'megabyte', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Share of host RAM. Takes MB on both sides and hands the RATIO to Intl. */
export function fmtHostPct(mb: number | null | undefined, hostMb: number | null): string {
  if (mb == null || !hostMb) return '—'
  return fmtPercent(mb / hostMb, { maximumFractionDigits: 2 })
}

/**
 * Uptime as a compound duration. Coarse on purpose: once a session is days old,
 * its seconds are noise, and a fixed `HH:MM:SS` clock is not a duration format
 * any locale agrees on.
 */
export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const parts: Array<[number, FormatUnit]> = [
    [Math.floor(s / 86400), 'day'],
    [Math.floor((s % 86400) / 3600), 'hour'],
    [Math.floor((s % 3600) / 60), 'minute'],
  ]
  return fmtDuration(parts, { dropZero: true, maximumFractionDigits: 0 })
}

/**
 * A session with no generated title yet must still be distinguishable — every
 * such row would otherwise read identically — so the slot key disambiguates it.
 */
export function rowName(row: SessionRow): string {
  if (row.untitled && row.slot_key) return `${row.title} ${row.slot_key}`
  return row.title || row.key
}

/**
 * Flatten sessions + tasks into display order: sessions by the chosen column,
 * each immediately followed by its own tasks, always by memory descending.
 *
 * Sorts unsampled rows (null memory) last rather than treating them as 0, so a
 * session still being measured does not masquerade as the smallest one. Tasks
 * stay welded under their parent instead of joining the global sort — a task's
 * number is only meaningful next to the session that owns it.
 */
export type SortKey = 'name' | 'rssMb' | 'peakMb' | 'procs' | 'mcp' | 'cpuCores' | 'uptimeS' | 'agent' | 'pid'

export function buildRows(
  sessions: SessionRow[],
  tasks: TaskRow[],
  sort: { key: SortKey; desc: boolean } = { key: 'rssMb', desc: true },
  filter = '',
): DisplayRow[] {
  const byMemDesc = (a: number | null, b: number | null): number => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return b - a
  }
  // Nulls sort last in BOTH directions: "unknown" is not a small value, and
  // flipping the column must not promote unmeasured rows to the top.
  const cmp = (a: DisplayRow, b: DisplayRow): number => {
    const av = a[sort.key] as number | string | null
    const bv = b[sort.key] as number | string | null
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    // compareText, not localeCompare: a bare localeCompare collates by the
    // BROWSER's locale, so a translated UI would sort its text columns in the
    // wrong language (src/i18n/localeFormatting.test.ts polices this).
    const d = typeof av === 'string' && typeof bv === 'string' ? compareText(av, bv) : Number(av) - Number(bv)
    return sort.desc ? -d : d
  }
  const needle = filter.trim().toLowerCase()
  const asRow = (s: SessionRow): DisplayRow => ({
    kind: 'session',
    id: s.key,
    name: rowName(s),
    agent: s.agent,
    rssMb: s.rss_mb,
    peakMb: null,
    cpuCores: s.cpu_cores,
    procs: s.procs,
    mcp: s.mcp,
    uptimeS: s.uptime_s,
    pid: s.pid,
    shared: !s.owns_runtime,
    href: sessionChatPath(s.key),
  })
  const out: DisplayRow[] = []
  const visible = sessions
    .map(asRow)
    .filter(r => !needle || r.name.toLowerCase().includes(needle) || r.agent.toLowerCase().includes(needle))
    .sort(cmp)
  for (const row of visible) {
    out.push(row)
    const mine = tasks
      .filter(t => t.parent === row.id)
      .sort((a, b) => byMemDesc(a.sampled ? a.rss_mb : null, b.sampled ? b.rss_mb : null))
    for (const t of mine) {
      out.push({
        kind: 'task',
        id: t.id,
        name: t.task,
        agent: t.agent,
        rssMb: t.sampled ? t.rss_mb : null,
        peakMb: t.sampled ? t.peak_rss_mb : null,
        cpuCores: t.sampled ? t.cpu_cores : null,
        procs: null,
        mcp: null,
        uptimeS: t.started_at ? Date.now() / 1000 - t.started_at : null,
        pid: t.pid,
        shared: t.shared,
        href: null,
      })
    }
  }
  return out
}

const NUM_CELL = 'px-3 py-1.5 text-right font-mono text-[12.5px] tabular-nums whitespace-nowrap'
const HEAD_BASE = 'px-3 py-1.5 text-[11px] font-medium text-muted whitespace-nowrap'
// Two separate constants rather than appending `text-left` to a right-aligned
// base: Tailwind resolves conflicting utilities by CSS source order, not by the
// order they appear in the class string, so `text-right text-left` silently kept
// the RIGHT alignment and the two text headers sat over left-aligned data.
const HEAD_CELL = `${HEAD_BASE} text-right`
const HEAD_CELL_L = `${HEAD_BASE} text-left`

export default function SessionMemoryCard() {
  const navigate = useNavigate()
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'rssMb', desc: true })
  const [filter, setFilter] = useState('')
  const { data } = useQuery<Payload>({
    queryKey: ['sessionsMemory'],
    queryFn: () => api.sessionsMemory(),
    refetchInterval: 5000,
  })

  const sessions = data?.sessions ?? []
  const tasks = data?.tasks ?? []
  const totals = data?.totals
  const hostMb = totals?.host_mb ?? null
  const rows = buildRows(sessions, tasks, sort, filter)

  const open = (href: string | null) => {
    if (href) navigate(href)
  }

  // Re-sorting is THE interaction on a task-manager table ("which one is
  // biggest?"), so every column is a button. Clicking the active column flips
  // direction; a new column starts descending, which is what you want for every
  // numeric column and is harmless for the two text ones.
  const Head = ({ col, label, left }: { col: SortKey; label: string; left?: boolean }) => (
    <th
      className={left ? HEAD_CELL_L : HEAD_CELL}
      aria-sort={sort.key === col ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => setSort(s => (s.key === col ? { key: col, desc: !s.desc } : { key: col, desc: true }))}
        className={`inline-flex items-center gap-1 cursor-pointer hover:text-text ${sort.key === col ? 'text-accent' : ''}`}
      >
        {label}
        {sort.key === col && <span aria-hidden="true">{sort.desc ? '▾' : '▴'}</span>}
      </button>
    </th>
  )

  return (
    <Card className="mb-6">
      {/* docs/page-layout.md: data sections are Card + CardTitle + InfoTip and a
          `table-striped` table — never a hand-rolled wrapper. The measurement
          caveat lives in the InfoTip rather than as body copy so it does not
          cost two lines of vertical space above the data. */}
      <CardTitle>
        {i18nT('pages.sessionMemoryCard.session_task_memory')}
        <InfoTip text={i18nT('pages.sessionMemoryCard.resident_memory_of_each_session_s_whole_process')} />
        <span className="ml-auto text-[12px] text-muted font-mono tabular-nums font-normal">
          {fmtMb(totals?.rss_mb ?? null)}
          {hostMb ? ` / ${fmtMb(hostMb)}` : ''}
          {totals?.host_pct != null ? ` · ${fmtPercent(totals.host_pct / 100, { maximumFractionDigits: 2 })}` : ''}
        </span>
      </CardTitle>

      <SearchInput
        placeholder={i18nT('pages.sessionMemoryCard.filter_sessions')}
        value={filter}
        onChange={e => setFilter(e.currentTarget.value)}
        className="mb-3"
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<MemoryStick className="lucide-inline" />}
          title={i18nT('pages.sessionMemoryCard.no_active_sessions')}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse table-striped">
            <thead>
              <tr className="bg-bg-elevated border-b border-border">
                <Head col="name" label={i18nT('pages.sessionMemoryCard.session_task')} left />
                <Head col="rssMb" label={i18nT('pages.sessionMemoryCard.memory')} />
                <th className={HEAD_CELL}>{i18nT('pages.sessionMemoryCard.host_share')}</th>
                <Head col="peakMb" label={i18nT('pages.sessionMemoryCard.peak')} />
                <Head col="procs" label={i18nT('pages.sessionMemoryCard.proc')} />
                <Head col="mcp" label={i18nT('pages.sessionMemoryCard.mcp')} />
                <Head col="cpuCores" label={i18nT('pages.sessionMemoryCard.cpu')} />
                <Head col="uptimeS" label={i18nT('pages.sessionMemoryCard.uptime')} />
                <Head col="agent" label={i18nT('pages.sessionMemoryCard.agent')} left />
                <Head col="pid" label={i18nT('pages.sessionMemoryCard.pid')} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={`${r.kind}:${r.id}`}
                  className={`border-b border-border/60 last:border-b-0 ${
                    r.href ? 'cursor-pointer hover:bg-bg-hover' : ''
                  }`}
                  {...(r.href
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': r.name,
                        onClick: () => open(r.href),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            open(r.href)
                          }
                        },
                      }
                    : {})}
                >
                  <td
                    className={`px-3 py-1.5 text-left text-[12.5px] max-w-[330px] truncate ${
                      r.kind === 'task' ? 'pl-9 text-text' : 'text-text-strong font-medium'
                    }`}
                    title={r.name}
                  >
                    {r.name}
                    {r.shared && (
                      <span className="ml-1.5 text-[10px] px-1.5 rounded border border-warn/40 text-warn align-[1px]">
                        {i18nT('pages.sessionMemoryCard.shared')}
                      </span>
                    )}
                  </td>
                  <td className={NUM_CELL}>{fmtMb(r.rssMb)}</td>
                  <td className={NUM_CELL}>{fmtHostPct(r.rssMb, hostMb)}</td>
                  <td className={NUM_CELL}>{fmtMb(r.peakMb)}</td>
                  <td className={NUM_CELL}>{r.procs != null ? fmtNumber(r.procs) : '—'}</td>
                  <td className={NUM_CELL}>{r.mcp != null ? fmtNumber(r.mcp) : '—'}</td>
                  <td className={NUM_CELL}>{r.cpuCores != null ? fmtNumber(r.cpuCores, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
                  <td className={NUM_CELL}>{fmtUptime(r.uptimeS)}</td>
                  <td className="px-3 py-1.5 text-left text-[11.5px] text-accent whitespace-nowrap">{r.agent}</td>
                  {/* A pid is an identifier, not a quantity: locale grouping
                      would render 4066648 as "4,066,648" and break copy-paste
                      into ps/kill. */}
                  <td className={NUM_CELL}>{r.pid != null ? String(r.pid) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ONE catalog value with placeholders, not four label/value pairs: adjacent
          keys glued by their values render as a single text run the translator
          cannot reorder, which the i18n render gate flags as fragment/multi-unit
          ("merge, not join"). */}
      <p className="mt-3 pt-3 border-t border-border text-[12px] text-muted">
        {i18nT('pages.sessionMemoryCard.footer_summary', {
          runtimes: fmtNumber(totals?.runtimes ?? 0),
          sessions: fmtNumber(sessions.length),
          tasks: fmtNumber(tasks.length),
          headroom: hostMb ? fmtMb(hostMb - (totals?.rss_mb ?? 0)) : '—',
        })}
      </p>
    </Card>
  )
}
