// Scratch page: each iso primitive next to the reference it copies from aryanashta.me. Not linked from the app.
import { IsoBox, IsoGhost, IsoStack, IsoTile, ISO, Poster, isoViewBox, shade } from '../iso'

// The RMSNorm figure, rebuilt from the box geometry in the site's markup (top-face points -> x, y, z, w, d, h).
const HBM = { x: 0, y: 0, w: 143, d: 99, h: 22 }
const PLATFORM = { x: 209, y: 16.5, w: 121, d: 66, h: 17.6 }
const SRAM = { x: 231, y: 31.9, z: 17.6, w: 66, d: 35.2, h: 26.4 }
const TOWER = { x: 363, y: 27.5, w: 33, d: 33, h: 57.68 }
const CEILING = { x: 356.4, y: 20.9, w: 46.2, d: 46.2, h: 77 }
const VB = isoViewBox([HBM, PLATFORM, SRAM, TOWER, CEILING], 12)

function RmsScene() {
  return (
    <>
      <IsoBox {...HBM} color="#d9e1ea" />
      <IsoBox {...PLATFORM} color="#b5c7e8" />
      {[0, 1, 2, 3, 4].map((i) => (
        <IsoBox key={i} x={150 + i * 11} y={44} w={11} d={11} h={6 + i * 2.5} color={ISO.accentTint} stroke={false} />
      ))}
      <IsoBox {...SRAM} color="#c9d6e9" />
      <IsoGhost {...CEILING} />
      <IsoBox {...TOWER} color={ISO.blue} />
    </>
  )
}

function Swatch({ base }: { base: string }) {
  const f = shade(base)
  return (
    <div className="flex items-center gap-3 text-sm">
      {[f.top, f.left, f.right].map((c) => (
        <span key={c} className="inline-block h-6 w-10 border border-rule" style={{ background: c }} title={c} />
      ))}
      <code className="text-slate">{base}</code>
    </div>
  )
}

export default function IsoTestScreen() {
  return (
    <main className="mx-auto max-w-[1080px] px-6 py-10">
      <h1 className="display text-4xl">Iso kit</h1>
      <p className="mt-2 max-w-[68ch] text-slate">Left: rebuilt with src/iso. Right: screenshot of aryanashta.me.</p>

      <section className="mt-10 border-t-2 border-ink pt-4">
        <h2 className="wide text-xl font-bold">Figure: RMSNorm scene</h2>
        <div className="mt-4 grid grid-cols-2 gap-6">
          <figure className="border border-rule">
            <svg viewBox={VB} className="block h-auto w-full" role="img" aria-label="Rebuilt RMSNorm figure">
              <RmsScene />
            </svg>
          </figure>
          <img src="/iso-ref/rmsnorm-figure.png" alt="Reference: RMSNorm figure on aryanashta.me" className="w-full border border-rule" />
        </div>
      </section>

      <section className="mt-10 border-t-2 border-ink pt-4">
        <h2 className="wide text-xl font-bold">Poster</h2>
        <div className="mt-4 grid grid-cols-3 gap-6">
          <Poster color={ISO.blue} number="No. 02" year="2026" title={['Fused', 'RMSNorm']} label="Rebuilt poster"
            metrics={[{ label: 'Forward', value: '240 GB/s' }, { label: 'vs. eager', value: '3.8×' }]} sceneViewBox={VB}>
            <RmsScene />
          </Poster>
          <img src="/iso-ref/rmsnorm-poster.png" alt="Reference: RMSNorm poster on aryanashta.me" className="w-full" />
        </div>
      </section>

      <section className="mt-10 border-t-2 border-ink pt-4">
        <h2 className="wide text-xl font-bold">Primitives</h2>
        <div className="mt-4 grid grid-cols-4 gap-6 text-sm">
          {[
            ['IsoBox', <IsoBox key="b" x={0} y={0} w={40} d={30} h={24} color={ISO.green} />],
            ['IsoGhost', <IsoGhost key="g" x={0} y={0} w={40} d={30} h={24} label="missing" />],
            ['IsoStack',
              <IsoStack key="s" x={0} y={0} w={30} d={30} layers={[
                { h: 12, color: ISO.blue }, { h: 6, color: ISO.green }, { h: 4, color: ISO.mustard }, { h: 10, color: ISO.gap, ghost: true },
              ]} />],
            ['IsoTile', <g key="t">{[0, 1, 2].map((i) => <IsoTile key={i} x={i * 18} y={0} w={16} d={30} color={ISO.mustard} />)}</g>],
          ].map(([name, node]) => (
            <figure key={name as string} className="border border-rule p-2">
              <svg viewBox={isoViewBox([{ x: 0, y: 0, w: 52, d: 30, h: 34 }], 10)} className="block h-40 w-full" role="img" aria-label={name as string}>
                {node}
              </svg>
              <figcaption className="text-slate">{name}</figcaption>
            </figure>
          ))}
        </div>
        <div className="mt-6 space-y-2">
          {['#d9e1ea', ISO.blue, ISO.green, ISO.mustard, ISO.gap, ISO.transit].map((c) => (
            <Swatch key={c} base={c} />
          ))}
        </div>
      </section>
    </main>
  )
}
