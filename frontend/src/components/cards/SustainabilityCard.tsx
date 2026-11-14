import { usePlan } from '../../state/PlanContext'
import { fmtNum } from '../../format'
import { CardShell, Section } from './common'
import TargetBars from '../TargetBars'
import FactorHover from '../FactorHover'

export default function SustainabilityCard() {
  const { state } = usePlan()
  const solar = state.plan.precomputed?.solar_kwh_per_kw_year
  return (
    <CardShell title="Sustainability & health" note={state.plan.notes?.sustainability_health}>
      <Section title="Targets">
        <TargetBars />
      </Section>
      {solar !== undefined && (
        <Section title="Solar resource">
          <FactorHover keys={['solar_kwh_per_kw_year', 'usable_roof_share', 'solar_kw_per_m2']}>
            <span className="text-sm">{solar === null ? 'missing' : `${fmtNum(solar)} kWh per kW per year`}</span>
          </FactorHover>
        </Section>
      )}
    </CardShell>
  )
}
