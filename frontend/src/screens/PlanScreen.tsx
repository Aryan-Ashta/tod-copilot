import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { stockPrompts } from '../api'
import { PlanProvider, usePlan } from '../state/PlanContext'
import ApplySuggestionsButton from '../components/ApplySuggestionsButton'
import Disclaimer from '../components/Disclaimer'
import AgentChecklist from '../components/AgentChecklist'
import AgentCard from '../components/cards/AgentCard'
import MapView, { type MapInsets } from '../components/MapView'
import LayerPanel from '../components/LayerPanel'
import TargetsPanel from '../components/TargetsPanel'
import UncertaintyQueue from '../components/UncertaintyQueue'
import SplitPane from '../components/SplitPane'
import { dataTierLabel } from '../format'
import type { StockPrompt } from '../types'

// Layers (top-left), the Apply button (top centre) and "more certain" bars (top-right) along the top; the Targets
// strip (TargetsPanel) along the bottom.
const PLAN_MAP_INSETS: MapInsets = { top: 84, right: 24, bottom: 242, left: 24 }

function PlanView({ replay }: { replay: boolean }) {
  const { state } = usePlan()
  const locale = state.locale
  // Stock prompts picked on the home page arrive as ?tags=<id,id>; unknown ids are skipped.
  const [params] = useSearchParams()
  const tagIds = (params.get('tags') ?? '').split(',').filter(Boolean)
  const [stock, setStock] = useState<StockPrompt[]>([])
  const wantTags = tagIds.length > 0
  useEffect(() => {
    if (!wantTags) return
    stockPrompts()
      .then(setStock)
      .catch(() => {})
  }, [wantTags])
  const tags = tagIds.flatMap((id) => stock.find((p) => p.id === id) ?? [])
  return (
    <div className="flex h-full flex-col">
      <Disclaimer>
        {locale && (
          <span>
            {locale.name}
            <span className="ml-2 text-slate">{dataTierLabel(locale)}</span>
            {locale.sources_from && locale.id.startsWith('area-') && <span className="ml-2 text-slate">recorded live</span>}
          </span>
        )}
        {tags.map((t) => (
          <span key={t.id} title={t.prompt} className="pop-in rounded-full border border-rule bg-white/60 px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-ink">
            {t.title}
          </span>
        ))}
        {replay && <span className="text-slate">recorded run</span>}
        <Link
          to={`/meeting/${state.planId}`}
          aria-disabled={!state.basePlan}
          className={`ctl px-3 py-1 text-[13px] no-underline ${state.basePlan ? '' : 'pointer-events-none border-rule text-slate shadow-none'}`}
        >
          Meeting mode
        </Link>
      </Disclaimer>
      <SplitPane
        storageKey="tod.split.plan"
        defaultFrac={0.3}
        leftLabel="Agents and results"
        left={
          <>
            <AgentChecklist />
            <AgentCard />
          </>
        }
        right={
          <>
            <MapView insets={PLAN_MAP_INSETS} agentFocus />
            <LayerPanel />
            {/* centred in the gap between LayerPanel (left-3 w-72) and UncertaintyQueue (right-3 w-96) */}
            <div className="pointer-events-none absolute top-3 right-[25.5rem] left-[19.5rem] z-10 flex justify-center">
              <ApplySuggestionsButton large className="pointer-events-auto" />
            </div>
            <UncertaintyQueue className="absolute top-3 right-3 z-10 w-96" />
            <TargetsPanel />
          </>
        }
      />
    </div>
  )
}

export default function PlanScreen() {
  const { planId = '' } = useParams()
  const [params] = useSearchParams()
  const replay = params.get('replay') === '1'
  return (
    <PlanProvider key={`${planId}:${replay}`} planId={planId} replay={replay}>
      <PlanView replay={replay} />
    </PlanProvider>
  )
}
