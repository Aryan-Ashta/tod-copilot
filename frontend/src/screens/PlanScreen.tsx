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
  return (
    <div className="flex h-full flex-col">
      <Disclaimer>
        {locale && (
          <span className="text-neutral-300">
            {locale.name}
            <span className="ml-2 rounded border border-neutral-700 px-1.5 text-[11px] text-neutral-400">
              {locale.data_tier === 'costar_full' ? 'CoStar full' : 'Public only'}
            </span>
          </span>
        )}
        {replay && <span className="rounded bg-neutral-800 px-1.5 text-[11px] text-neutral-300">recorded run</span>}
        <Link
          to={`/meeting/${state.planId}`}
          className={`rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800 ${state.basePlan ? '' : 'pointer-events-none opacity-40'}`}
        >
          Meeting mode
        </Link>
      </Disclaimer>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[640px] shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          {state.plan.prompt && <p className="border-b border-neutral-800 px-4 py-2 text-sm text-neutral-400">“{state.plan.prompt}”</p>}
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
