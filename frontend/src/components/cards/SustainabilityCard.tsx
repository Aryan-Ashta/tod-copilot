import { usePlan } from '../../state/PlanContext'
import { fmtNum } from '../../format'
import { CardShell, Section } from './common'
import { EcoFigure } from './EcoFigure'
import TargetBars from '../TargetBars'
import FactorHover from '../FactorHover'

export default function SustainabilityCard() {
  const { state } = usePlan()
  const solar = state.plan.precomputed?.solar_kwh_per_kw_year
  const targets = state.plan.targets
  return (
    <CardShell title="Sustainability & health" note={state.plan.notes?.sustainability_health}>
      {targets && targets.length > 0 && (
        <Section title="At a glance" right={<span className="text-xs text-slate">agents' suggestion</span>}>
          <EcoFigure targets={targets} localeId={state.plan.locale?.id} solarMissing={solar === null} />
        </Section>
      )}
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
