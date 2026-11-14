import type { ComponentType } from 'react'
import { usePlan } from '../../state/PlanContext'
import type { AgentName } from '../../types'
import InfrastructureCard from './InfrastructureCard'
import TransitCard from './TransitCard'
import ZoningCard from './ZoningCard'
import SiteCard from './SiteCard'
import BuildingReuseCard from './BuildingReuseCard'
import LandDealCard from './LandDealCard'
import FundingCard from './FundingCard'
import SustainabilityCard from './SustainabilityCard'

const CARDS: Record<Exclude<AgentName, 'coordinator'>, ComponentType> = {
  infrastructure: InfrastructureCard,
  transit_network: TransitCard,
  zoning_legislation: ZoningCard,
  site: SiteCard,
  building_reuse: BuildingReuseCard,
  land_deal: LandDealCard,
  funding: FundingCard,
  sustainability_health: SustainabilityCard,
}

export default function AgentCard() {
  const { state } = usePlan()
  const agent = state.selectedAgent
  const Card = agent === 'coordinator' ? InfrastructureCard : CARDS[agent]
  const err = state.plan.agent_errors?.[agent]
  return (
    <>
      {err && <div className="mx-4 mt-4 rounded border border-rose-900 bg-rose-950/50 p-2 text-sm text-rose-300">Agent error: {err}</div>}
      <Card />
    </>
  )
}
