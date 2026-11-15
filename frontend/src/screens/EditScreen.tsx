import { useCallback, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PlanProvider, suggestionsApplied, usePlan, type RejectionNotice } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import ApplySuggestionsButton from '../components/ApplySuggestionsButton'
import Disclaimer from '../components/Disclaimer'
import FactorHover from '../components/FactorHover'
import Hints from '../components/Hints'
import HistoryPanel from '../components/HistoryPanel'
import LayerPanel from '../components/LayerPanel'
import MapView, { type MapInsets } from '../components/MapView'
import Scoreboard from '../components/Scoreboard'
import SplitPane from '../components/SplitPane'
import StatsPanel from '../components/StatsPanel'
import { GreenSpaceSlider } from '../components/TargetsPanel'
import TileTray, { TileGlyph, tileInfo } from '../components/TileTray'

// Layers panel (collapsed header) at the top left; green-space slider stacked on the tile tray at the bottom. The
// history/stats panel and the scoreboard bar sit outside the map.
const EDIT_MAP_INSETS: MapInsets = { top: 64, right: 32, bottom: 132, left: 32 }

/** Rejected placement: what was refused, where, why, and the rule or factor behind it. Auto-dismisses after 7 s. */
function RejectionToast({ notice, onClose }: { notice: RejectionNotice; onClose: () => void }) {
  const { openCitation } = useApp()
  const { rejection, title, where, tile } = notice
  useEffect(() => {
    const t = setTimeout(onClose, 7000)
    return () => clearTimeout(t)
  }, [notice.nonce, onClose])
  // centred in the room right of the Layers panel (left-3 w-72) so both stay readable
  return (
    <div className="pointer-events-none absolute top-3 right-3 left-[19.5rem] z-20 flex justify-center">
      <div
        className="pop-in pointer-events-auto w-full max-w-[720px] rounded-[12px] border-[1.5px] border-ink border-l-4 border-l-gap bg-paper p-4 text-lg shadow-[0_8px_24px_rgb(28_34_48/.16)]"
        role="alert"
      >
        <div className="flex items-start gap-3">
          {tile && <TileGlyph kind={tile} ghost className="h-10 w-10 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              Not placed: {title}
              {where && <span className="font-normal text-slate"> · {where}</span>}
            </div>
            <div className="mt-0.5 text-base">{rejection.reason}</div>
            {(rejection.citation || rejection.factor_key) && (
              <div className="mt-1 flex flex-wrap gap-3 text-base">
                {rejection.citation && (
                  <button onClick={() => openCitation(rejection.citation!)} className="text-blue underline">
                    § {rejection.citation.section} ({rejection.citation.doc_id})
                  </button>
                )}
                {rejection.factor_key && (
                  <FactorHover keys={[rejection.factor_key]}>
                    <span className="text-slate">factor {rejection.factor_key}</span>
                  </FactorHover>
                )}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Dismiss" className="ctl px-2 py-0.5">
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

function Edit() {
  const { state, dispatch } = usePlan()
  const plan = state.plan
  const applied = suggestionsApplied(state)
  const closeRejection = useCallback(() => dispatch({ type: 'dismiss_rejection' }), [dispatch])
  const tool = state.tool ? tileInfo(state.tool) : null

  const side = (
    <div className="flex flex-col gap-4 px-5 pt-4 pb-6 text-base">
      {!applied && <ApplySuggestionsButton className="w-full justify-center" />}
      <HistoryPanel />
      {state.loadError && <p className="text-sm text-gap">Could not load plan: {state.loadError}</p>}
      <h2 className="wide mt-2 border-t-2 border-ink pt-3 text-[22px] font-bold">Statistics</h2>
      <StatsPanel />
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <Disclaimer large>
        <span>{state.locale?.name ?? ''}</span>
        <Link to={`/plan/${state.planId}`} className="ctl px-3 py-1 text-[14px] no-underline">
          Plan view
        </Link>
      </Disclaimer>
      <SplitPane
        storageKey="tod.split.meeting"
        defaultFrac={0.26}
        leftLabel="History and statistics"
        left={side}
        right={
          <div className="absolute inset-0" data-hint-anchor="map">
            <MapView large insets={EDIT_MAP_INSETS} />
            <LayerPanel />
            {state.rejection && <RejectionToast key={state.rejection.nonce} notice={state.rejection} onClose={closeRejection} />}
            {/* bottom stack: tool hint, green-space slider, tile tray */}
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2.5 px-3">
              {tool && state.tool && (
                <div
                  key={state.tool}
                  role="status"
                  className="hint-in flex items-center gap-2 rounded-full border-[1.5px] border-ink bg-paper/95 py-1 pr-3.5 pl-1.5 text-[14px] font-semibold shadow-[1.5px_1.5px_0_var(--color-ink),0_6px_18px_rgb(28_34_48/.14)]"
                >
                  <TileGlyph kind={state.tool} className="h-7 w-7" />
                  <span>
                    Click a highlighted {tool.target === 'building' ? 'building' : 'lot'}
                    <span className="font-normal text-slate"> · Esc to cancel</span>
                  </span>
                </div>
              )}
              {/* also shows a failed rescore, from tiles or the slider */}
              <GreenSpaceSlider className="pointer-events-auto w-[min(100%,28rem)] rounded-[16px] border border-rule bg-paper/95 py-0.5 pr-1.5 pl-2.5 shadow-[0_6px_18px_rgb(28_34_48/.12)] backdrop-blur-sm" />
              <div className="pointer-events-auto">
                <TileTray />
              </div>
            </div>
            {!plan.parcels && !state.loadError && (
              <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 text-xl text-slate">Loading plan…</div>
            )}
          </div>
        }
      />
      <footer className="shrink-0 border-t-[1.5px] border-ink bg-paper">
        <Scoreboard />
      </footer>
      <Hints />
    </div>
  )
}

export default function EditScreen() {
  const { planId = '' } = useParams()
  return (
    <PlanProvider key={planId} planId={planId} mode="static">
      <Edit />
    </PlanProvider>
  )
}
