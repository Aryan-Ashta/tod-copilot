import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PlanProvider, usePlan } from '../state/PlanContext'
import Disclaimer from '../components/Disclaimer'
import AgentChecklist from '../components/AgentChecklist'
import AgentCard from '../components/cards/AgentCard'
import MapView from '../components/MapView'
import LayerPanel from '../components/LayerPanel'
import TargetsPanel from '../components/TargetsPanel'
import UncertaintyQueue from '../components/UncertaintyQueue'

function PlanView({ replay }: { replay: boolean }) {
  const { state } = usePlan()
  const locale = state.locale
  const o = state.plan.options
  const optionChips = o
    ? [
        o.focus !== 'all' && `focus: ${o.focus.replace('_', ' ')}`,
        o.goals.affordable_homes !== null && `affordable homes goal: ${o.goals.affordable_homes}`,
        o.goals.total_homes !== null && `homes goal: ${o.goals.total_homes}`,
        o.goals.conversions !== null && `conversions goal: ${o.goals.conversions}`,
        o.goals.transit_coverage_pct !== null && `transit coverage goal: ${o.goals.transit_coverage_pct}%`,
      ].filter((c): c is string => !!c)
    : []
  return (
    <div className="flex h-full flex-col">
      <Disclaimer>
        {locale && (
          <span>
            {locale.name}
            <span className="ml-2 text-slate">{locale.data_tier === 'costar_full' ? 'CoStar full' : 'Public only'}</span>
            {locale.sources_from && locale.id.startsWith('area-') && <span className="ml-2 text-slate">recorded live</span>}
          </span>
        )}
        {optionChips.map((c) => (
          <span key={c} className="text-slate">
            {c}
          </span>
        ))}
        {replay && <span className="text-slate">recorded run</span>}
        <Link
          to={`/meeting/${state.planId}`}
          className={`border-b border-ink pb-px no-underline ${state.basePlan ? '' : 'pointer-events-none border-rule text-slate'}`}
        >
          Meeting mode
        </Link>
      </Disclaimer>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[640px] shrink-0 flex-col overflow-y-auto border-r border-rule">
          {state.plan.prompt && <p className="border-b border-rule px-5 py-2.5 text-[15px] text-slate">“{state.plan.prompt}”</p>}
          <AgentChecklist />
          <AgentCard />
        </aside>
        <main className="relative min-w-0 flex-1">
          <MapView />
          <LayerPanel />
          <UncertaintyQueue className="absolute top-3 right-3 z-10 w-96" />
          <TargetsPanel />
        </main>
      </div>
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
