import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PlanProvider, usePlan } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import Disclaimer from '../components/Disclaimer'
import MapView, { type MapHandle } from '../components/MapView'
import Scoreboard from '../components/Scoreboard'
import TileTray, { TILE_MIME, TileGlyph, tileInfo } from '../components/TileTray'
import FactorHover from '../components/FactorHover'
import { buildingLabel, parcelLabel } from '../format'
import type { Citation, TileKind } from '../types'

interface Toast {
  text: string
  citation?: Citation | null
  factorKey?: string | null
  nonce: number
}

interface Ghost {
  tile: TileKind
  x: number
  y: number
  back: boolean
}

let toastSeq = 0

function Meeting() {
  const { state, dispatch, addEdit } = usePlan()
  const { openCitation } = useApp()
  const handleRef = useRef<MapHandle | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  // Mirror of `ghost` so effects can read the pending drop synchronously.
  const ghostRef = useRef<Ghost | null>(null)
  const handledRejection = useRef<number | null>(null)
  const plan = state.plan

  const showGhost = (g: Ghost | null) => {
    ghostRef.current = g
    setGhost(g)
  }

  const snapBack = (g: Ghost) => {
    const r = document.querySelector(`[data-tile="${g.tile}"]`)?.getBoundingClientRect()
    showGhost(r ? { ...g, x: r.left + r.width / 2, y: r.top + r.height / 2, back: true } : null)
    setTimeout(() => {
      if (ghostRef.current?.back) showGhost(null)
    }, 450)
  }

  // Rejected drop → toast with reason + citation/factor, tile snaps back to the tray.
  useEffect(() => {
    const rej = state.rejection
    if (!rej || handledRejection.current === rej.nonce) return
    handledRejection.current = rej.nonce
    setToast({ text: rej.rejection.reason, citation: rej.rejection.citation, factorKey: rej.rejection.factor_key, nonce: ++toastSeq })
    const g = ghostRef.current
    if (g && !g.back) snapBack(g)
  }, [state.rejection])

  // New scoreboard (accepted) or a failed rescore → the pending tile is resolved.
  useEffect(() => {
    const g = ghostRef.current
    if (g && !g.back) showGhost(null)
  }, [state.scoredKey, state.rescoreError])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast((x) => (x?.nonce === toast.nonce ? null : x)), 7000)
    return () => clearTimeout(t)
  }, [toast])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const tile = e.dataTransfer.getData(TILE_MIME) as TileKind
    if (!tile) return
    const info = tileInfo(tile)
    const g: Ghost = { tile, x: e.clientX, y: e.clientY, back: false }
    const picked = handleRef.current?.pick(e.clientX, e.clientY, [info.target === 'building' ? 'buildings' : 'parcels'])
    let targetId: string
    let where: string
    if (picked?.layer === 'buildings') {
      targetId = picked.building.id
      where = buildingLabel(picked.building, targetId)
    } else if (picked?.layer === 'parcels') {
      targetId = picked.parcel.id
      where = parcelLabel(picked.parcel, targetId)
    } else {
      setToast({ text: `Drop on a ${info.target}`, nonce: ++toastSeq })
      showGhost(g)
      requestAnimationFrame(() => snapBack(g))
      return
    }
    setToast(null)
    showGhost(g)
    addEdit({ kind: 'place_tile', tile, target_id: targetId }, `Added ${info.label} on ${where}`)
  }

  const sel = state.selected
  const selTarget = sel.buildingId ?? sel.parcelId
  const lastOnTarget = selTarget
    ? [...state.edits].reverse().find((e) => e.edit.kind !== 'slider' && e.edit.target_id === selTarget)
    : undefined
  const placed = lastOnTarget?.edit.kind === 'place_tile' ? lastOnTarget : undefined

  return (
    <div className="flex h-full flex-col">
      <Disclaimer large>
        <span>{state.locale?.name ?? ''}</span>
        <Link to={`/plan/${state.planId}`} className="border-b border-ink text-base">
          Plan view
        </Link>
      </Disclaimer>
      <div className="relative flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <MapView handleRef={handleRef} large />
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
          <div className="pointer-events-auto w-full max-w-5xl">
            <Scoreboard />
          </div>
        </div>
        {toast && (
          <div className="absolute top-40 left-1/2 z-20 w-[min(90vw,720px)] -translate-x-1/2 border border-ink border-l-4 border-l-gap bg-paper p-4 text-lg" role="alert">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">Not placed: {toast.text}</div>
                <div className="mt-1 flex flex-wrap gap-3 text-base">
                  {toast.citation && (
                    <button onClick={() => openCitation(toast.citation!)} className="text-blue underline">
                      § {toast.citation.section} ({toast.citation.doc_id})
                    </button>
                  )}
                  {toast.factorKey && (
                    <FactorHover keys={[toast.factorKey]}>
                      <span className="text-slate">factor {toast.factorKey}</span>
                    </FactorHover>
                  )}
                </div>
              </div>
              <button onClick={() => setToast(null)} aria-label="Dismiss" className="ctl px-2 py-0.5">
                ✕
              </button>
            </div>
          </div>
        )}
        <div className="absolute right-3 bottom-28 z-10 w-96 border border-rule bg-paper p-3 text-base">
          <div className="mb-2 flex items-center gap-2 border-b border-rule pb-2">
            <span className="font-semibold">Changes</span>
            {state.rescoring && <span className="text-sm text-slate">updating…</span>}
            <div className="ml-auto flex gap-2">
              <button
                disabled={!state.edits.length}
                onClick={() => dispatch({ type: 'undo' })}
                className="ctl disabled:opacity-40"
              >
                Undo
              </button>
              <button
                disabled={!state.edits.length}
                onClick={() => dispatch({ type: 'reset' })}
                className="ctl disabled:opacity-40"
              >
                Reset
              </button>
            </div>
          </div>
          {state.history.length === 0 ? (
            <p className="text-sm text-slate">Drag a tile from the tray onto a parcel or building.</p>
          ) : (
            <ol className="max-h-56 list-decimal space-y-1 overflow-y-auto pl-5 text-sm">
              {state.history.map((h) => (
                <li key={h.id}>{h.text}</li>
              ))}
            </ol>
          )}
          {placed && (
            <button
              onClick={() =>
                addEdit({ kind: 'remove_tile', target_id: selTarget }, `Removed ${placed.label.replace(/^Added /, '')}`)
              }
              className="ctl mt-2 w-full"
            >
              Remove tile on selection
            </button>
          )}
          {state.rescoreError && <p className="mt-1 text-sm text-rose-400">Rescore failed: {state.rescoreError}</p>}
          {state.loadError && <p className="mt-1 text-sm text-rose-400">Could not load plan: {state.loadError}</p>}
        </div>
        <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <TileTray disabled={!state.basePlan} />
        </div>
        {!plan.parcels && !state.loadError && (
          <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 text-xl text-slate">Loading plan…</div>
        )}
      </div>
      {ghost && (
        <div
          className={`pointer-events-none fixed z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-lg font-semibold ${ghost.back ? 'opacity-50 transition-all duration-400 ease-in' : ''}`}
          style={{ left: ghost.x, top: ghost.y }}
        >
          <TileGlyph kind={ghost.tile} ghost className="h-20 w-20" />
          <span className="bg-paper/90 px-1">{tileInfo(ghost.tile).label}</span>
        </div>
      )}
    </div>
  )
}

export default function MeetingScreen() {
  const { planId = '' } = useParams()
  return (
    <PlanProvider key={planId} planId={planId} mode="static">
      <Meeting />
    </PlanProvider>
  )
}
