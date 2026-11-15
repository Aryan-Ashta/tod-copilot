"""QA: building reuse scores (models/reuse.py) and zoning envelopes (models/zoning.py) on the three demo locales.

Sanity invariants a planner would expect of the reuse numbers the demo shows. Monotonicity probes perturb one real
candidate per locale (its largest in-plan conversion, else its largest building with an acquisition basis) with
model_copy and re-score it with the plan's own legal paths, readiness, walk and acquisition basis. xfails marked
QA-REUSE-<n> are today's bugs; findings and fixes: local://qa-reuse.md.
"""
import math
from datetime import date, datetime, timezone

import pytest

from backend.agents.zoning_legislation import conversion_paths, is_conversion_only, is_new_construction_only
from backend.data.factors import resolve
from backend.models import finance, reuse, targets, zoning
from backend.models import rescore as rs
from backend.schemas import ConversionCandidate, Edit, Provenance, Site, Sourced

LOCALES = ("houston_downtown", "la_wilshire_koreatown", "brevard_cocoa")
CONF = reuse.CONF_ORDER
PHYSICAL = ("floor_depth_ft", "typical_floor_sqft", "ceiling_height_ft", "window_wall_pct", "stories", "year_built")
LIMITS = ("max_units_per_acre", "max_height_ft", "max_far")
_T = datetime(2026, 11, 13, tzinfo=timezone.utc)


def _xfail(n: int, reason: str, *only: str) -> list:
    """The three locales; the listed ones (all when none are listed) strict-xfail with QA-REUSE-<n>."""
    marked = set(only or LOCALES)
    mark = pytest.mark.xfail(strict=True, reason=f"QA-REUSE-{n}: {reason}")
    return [pytest.param(L, marks=mark) if L in marked else L for L in LOCALES]


def _sv(v, conf: str = "medium") -> Sourced:
    return Sourced(value=v, prov=Provenance(source="qa_probe", confidence="missing" if v is None else conf,
                                            retrieved_at=_T))


def _with(b, **vals):
    return b.model_copy(update={k: _sv(v) for k, v in vals.items()})


def _wmean(fit, w: dict) -> float:
    return sum(w[k] * getattr(fit, k) for k in w) / sum(w.values())


def _detail(c, use: str, fit: str, name: str):
    return next(d for d in c.details if d.use == use and d.fit == fit and d.name == name)


class _Locale:
    """The plan's inputs to score_reuse, as the building reuse agent passes them (agents/building_reuse.scorer)."""

    def __init__(self, p):
        self.p, self.f = p, resolve(p.locale.id)
        self.buildings = {b.id: b for b in p.buildings}
        self.parcels = {x.id: x for x in p.parcels}
        self.envs = {e.parcel_id: e for e in p.envelopes}
        self.ready = {x.target_id: x for x in p.readiness}
        self.cands = {c.building_id: c for c in p.conversions}

    def acquisition(self, b):
        par = self.parcels.get(b.parcel_id)
        if par is None:
            return None
        basis = finance.acquisition_basis(par.last_sale_usd.value, par.assessed_value_usd.value)
        src = par.last_sale_usd if par.last_sale_usd.value is not None else par.assessed_value_usd
        return Sourced(value=basis, prov=src.prov) if basis is not None else None

    def score(self, b, acquisition="plan"):
        env = self.envs.get(b.parcel_id)
        acq = self.acquisition(b) if acquisition == "plan" else acquisition
        return reuse.score_reuse(b, conversion_paths(env.paths) if env else None, self.ready.get(b.id),
                                 self.p.precomputed.walk_m.get(b.id, {}), acq, self.f, locale_id=self.p.locale.id,
                                 data_tier=self.p.locale.data_tier)

    def anchor(self):
        """Largest in-plan conversion, else the largest building with a rentable area and an acquisition basis.
        Its re-score must reproduce the plan's candidate, so perturbations start from what the demo shows."""
        size = lambda b: (-(b.rentable_area_sqft.value or 0), b.id)  # noqa: E731
        sited = [self.buildings[s.building_id] for s in self.p.sites if s.kind == "conversion" and rs.in_plan(s)]
        pool = sited or [b for b in self.buildings.values()
                         if b.rentable_area_sqft.value and self.acquisition(b) is not None]
        b = min(pool, key=size)
        assert self.score(b).model_dump() == self.cands[b.id].model_dump()
        return b


def _good_physical(f: dict) -> dict:
    lo, hi = f["reuse_floor_sqft_range_residential"]
    return {"floor_depth_ft": 0.8 * f["reuse_max_floor_depth_ft_residential"], "typical_floor_sqft": (lo + hi) / 2,
            "ceiling_height_ft": f["reuse_min_ceiling_height_ft"] + 2, "window_wall_pct": f["reuse_min_window_wall_pct"] + 20,
            "stories": 5 * f["reuse_min_stories"], "year_built": date.today().year - 2 * f["reuse_min_building_age_years"]}


# ---------------------------------------------------------------- score structure


@pytest.mark.parametrize("L", LOCALES)
def test_fit_scores_bounded_and_overall_is_weighted_mean_of_best_use(plans, L):
    p = plans(L)
    w = resolve(L)["reuse_weights"]
    for c in p.conversions:
        for use, fit in c.scores_by_use.items():
            for k in w:
                v = getattr(fit, k)
                assert math.isfinite(v) and 0 <= v <= 1, (c.building_id, use, k, v)
        assert 0 <= c.overall <= 1
        assert c.overall == pytest.approx(_wmean(c.scores_by_use[c.best_use], w), abs=1e-3), c.building_id


@pytest.mark.parametrize("L", LOCALES)
def test_best_use_is_argmax_unless_keep_wins_by_margin(plans, L):
    f = resolve(L)
    margin = f["reuse_keep_margin"]
    for c in plans(L).conversions:
        ov = {u: _wmean(s, f["reuse_weights"]) for u, s in c.scores_by_use.items()}
        best_conv = max(ov[u] for u in reuse.CONVERT_USES)
        if c.best_use == "keep_current":
            assert best_conv < ov["keep_current"] + margin + 1e-3, c.building_id
            assert c.legal_path is None and c.embodied_co2_saved_tonnes is None
        else:
            assert ov[c.best_use] >= best_conv - 1e-3, c.building_id
            assert ov[c.best_use] >= ov["keep_current"] + margin - 1e-3, c.building_id


# ---------------------------------------------------------------- monotonicity on a real candidate


@pytest.mark.parametrize("L", LOCALES)
def test_deeper_floor_beyond_limit_lowers_residential_fit(plans, L):
    lc = _Locale(plans(L))
    b, hi = lc.anchor(), lc.f["reuse_max_floor_depth_ft_residential"]
    depths = [0.5 * hi, hi, 1.1 * hi, 1.3 * hi, 1.6 * hi, 2.0 * hi]
    cs = [lc.score(_with(b, floor_depth_ft=d)) for d in depths]
    depth_s = [_detail(c, "residential", "physical", "floor depth").score for c in cs]
    phys = [c.scores_by_use["residential"].physical for c in cs]
    res = [_wmean(c.scores_by_use["residential"], lc.f["reuse_weights"]) for c in cs]
    assert depth_s[0] == depth_s[1] == 1.0          # within the limit: no penalty
    assert all(a > b_ for a, b_ in zip(depth_s[1:], depth_s[2:])), depth_s   # every extra foot beyond it costs
    assert all(a >= b_ for a, b_ in zip(phys, phys[1:])) and phys[-1] < phys[1], phys
    assert all(a >= b_ for a, b_ in zip(res, res[1:])) and res[-1] < res[1], res


@pytest.mark.parametrize("L", LOCALES)
def test_vacancy_raises_conversion_appeal_and_lowers_keep(plans, L):
    lc = _Locale(plans(L))
    b, thr = lc.anchor(), lc.f["reuse_vacancy_threshold_pct"]
    vac = [0, 0.2 * thr, 0.5 * thr, thr, 2 * thr, 100]
    cs = [lc.score(_with(b, vacancy_pct=v)) for v in vac]
    conv = [c.scores_by_use["residential"].market for c in cs]
    keep = [c.scores_by_use["keep_current"].market for c in cs]
    w = lc.f["reuse_weights"]
    gap = [_wmean(c.scores_by_use["residential"], w) - _wmean(c.scores_by_use["keep_current"], w) for c in cs]
    upto = vac.index(thr) + 1
    assert all(a < b_ for a, b_ in zip(conv[:upto], conv[1:upto])), conv
    assert all(a <= b_ for a, b_ in zip(conv, conv[1:])), conv
    assert all(a > b_ for a, b_ in zip(keep[:upto], keep[1:upto])), keep
    assert all(a >= b_ for a, b_ in zip(keep, keep[1:])), keep
    assert all(a <= b_ + 1e-9 for a, b_ in zip(gap, gap[1:])), gap
    assert keep[0] > conv[0] and conv[-1] > keep[-1]   # a full building is worth keeping, an empty one converting


@pytest.mark.parametrize("L", LOCALES)
def test_higher_office_rent_lowers_conversion_market(plans, L):
    lc = _Locale(plans(L))
    b = lc.anchor()
    m = [lc.score(_with(b, asking_rent_usd_sqft_yr=r)).scores_by_use["residential"].market for r in (5, 15, 25, 35, 50)]
    assert all(a >= b_ for a, b_ in zip(m, m[1:])) and m[0] > m[-1], m


@pytest.mark.parametrize("L", LOCALES)
def test_more_rentable_area_means_more_units_and_more_embodied_carbon_saved(plans, L):
    lc = _Locale(plans(L))
    b = lc.anchor()
    areas = [50_000, 100_000, 200_000, 400_000, 800_000]
    cs = [lc.score(_with(b, rentable_area_sqft=a)) for a in areas]
    units = [c.est_units for c in cs]
    assert units == [reuse.units_for(a, lc.f) for a in areas]
    assert all(0 <= x < y for x, y in zip(units, units[1:])), units
    for a, c in zip(areas, cs):
        expect = round(targets.embodied_co2_saved(a, lc.f), 1) if c.best_use != "keep_current" else None
        assert c.embodied_co2_saved_tonnes == expect, (a, c.best_use)
    saved = [c.embodied_co2_saved_tonnes for c in cs if c.embodied_co2_saved_tonnes is not None]
    assert all(0 < x < y for x, y in zip(saved, saved[1:])), saved


@pytest.mark.parametrize("L", LOCALES)
def test_a_missing_physical_input_never_scores_as_a_met_threshold(plans, L):
    lc = _Locale(plans(L))
    good = _good_physical(lc.f)
    b = _with(lc.anchor(), **good)
    full = lc.score(b)
    assert full.scores_by_use["residential"].physical == 1.0
    w = lc.f["reuse_weights"]
    for k in PHYSICAL:
        c = lc.score(_with(b, **{k: None}))
        assert c.scores_by_use["residential"].physical < 1.0, k
        assert _wmean(c.scores_by_use["residential"], w) < _wmean(full.scores_by_use["residential"], w), k


@pytest.mark.parametrize("L", _xfail(2, "confidence is the min over present inputs, so dropping one can raise it",
                                     "houston_downtown", "la_wilshire_koreatown"))
def test_removing_a_physical_input_never_raises_confidence(plans, L):
    lc = _Locale(plans(L))
    b = lc.anchor()
    base = lc.score(b).confidence
    for k in PHYSICAL:
        if getattr(b, k).value is None:
            continue
        c = lc.score(_with(b, **{k: None}))
        assert CONF[c.confidence] <= CONF[base], (k, base, c.confidence)


@pytest.mark.parametrize("L", _xfail(3, "missing acquisition/rentable scores 0.5 financial, above every measured building"))
def test_missing_financial_inputs_score_no_better_than_every_measured_building(plans, L):
    lc = _Locale(plans(L))
    measured = [d.score for c in lc.p.conversions for d in c.details
                if d.use == "residential" and d.fit == "financial" and d.value is not None]
    assert measured
    missing = lc.score(lc.anchor(), acquisition=None).scores_by_use["residential"].financial
    assert missing <= max(measured), (missing, max(measured))


# ---------------------------------------------------------------- mixed use and zero-unit edge cases


@pytest.mark.parametrize("L", _xfail(1, "mixed-use retail NOI on the typical floor is not taken out of the residential area"))
def test_mixed_use_cannot_outearn_both_pure_uses_on_the_same_building(plans, L):
    """Mixed use splits one building's area between homes and retail at the same cost, so its margin cannot beat both
    all-residential and all-retail (retail priced as the model prices mixed-use retail)."""
    lc = _Locale(plans(L))
    f = lc.f
    retail_noi_per_sqft = f["retail_rent_usd_sqft_yr"] * (1 - f["vacancy_rate"] - f["opex_ratio"])
    bad = []
    for c in lc.p.conversions:
        b = lc.buildings[c.building_id]
        mixed = _detail(c, "mixed_use", "financial", "pro forma margin").value
        if mixed is None:
            continue
        res = _detail(c, "residential", "financial", "pro forma margin").value
        area = b.rentable_area_sqft.value
        retail = finance.conversion_pro_forma(0, lc.acquisition(b).value, area, f, 0.0,
                                              extra_noi_usd=area * retail_noi_per_sqft)["margin"]
        if mixed > max(res, retail) + 0.02:
            bad.append((c.building_id, b.stories.value, res, round(retail, 4), mixed))
    assert not bad, f"{len(bad)} buildings, e.g. {bad[:3]}"


@pytest.mark.parametrize("L", _xfail(1, "mixed-use retail NOI is earned even with zero rentable area"))
def test_zero_rentable_area_earns_nothing_in_any_use(plans, L):
    lc = _Locale(plans(L))
    c = lc.score(_with(lc.anchor(), rentable_area_sqft=0.0))
    assert c.est_units == 0
    assert {u: c.scores_by_use[u].financial for u in reuse.CONVERT_USES} == {u: 0.0 for u in reuse.CONVERT_USES}


@pytest.mark.parametrize("L", _xfail(7, "a building too small for one home is still recommended for homes",
                                     "houston_downtown", "la_wilshire_koreatown"))
def test_a_building_too_small_for_one_home_is_not_recommended_for_homes(plans, L):
    lc = _Locale(plans(L))
    small = 0.5 * lc.f["avg_unit_sqft_residential"] / lc.f["reuse_efficiency_factor"]
    c = lc.score(_with(lc.anchor(), rentable_area_sqft=small))
    assert c.est_units == 0
    assert c.best_use not in ("residential", "mixed_use"), (c.best_use, c.overall)


# ---------------------------------------------------------------- embodied carbon and units, candidate -> plan


@pytest.mark.parametrize("L", LOCALES)
def test_candidate_embodied_carbon_is_the_target_formula_on_rentable_area(plans, L):
    lc = _Locale(plans(L))
    for c in lc.p.conversions:
        area = lc.buildings[c.building_id].rentable_area_sqft.value
        expect = (round(targets.embodied_co2_saved(area, lc.f), 1)
                  if c.best_use != "keep_current" and area is not None else None)
        assert c.embodied_co2_saved_tonnes == expect, c.building_id
        assert expect is None or expect >= 0


def _conv_embodied(sites, convs: dict) -> tuple[float, int]:
    picked = [convs[s.building_id] for s in sites if rs.in_plan(s) and s.kind == "conversion"]
    picked = [c for c in picked if c.best_use != "keep_current"]
    return sum(c.embodied_co2_saved_tonnes or 0 for c in picked), len(picked)


@pytest.mark.parametrize("L", LOCALES)
def test_scoreboard_embodied_carbon_is_the_sum_over_in_plan_conversions(plans, L):
    p = plans(L)
    lc = _Locale(p)
    r = rs.rescore(p, [], lc.f)
    total, n = _conv_embodied(p.sites, lc.cands)
    assert r.scoreboard.embodied_co2_saved_tonnes == pytest.approx(total, abs=0.05 * n + 1e-9)
    assert r.scoreboard.embodied_co2_saved_tonnes == {t.key: t.value for t in p.targets}["embodied_co2_saved"]
    # three more conversions, one at a time: each adds its own embodied carbon, and the total stays the sum
    sited = {s.building_id for s in p.sites if s.kind == "conversion"}
    flood = p.precomputed.in_flood
    extra = [c for c in p.conversions if c.building_id not in sited and not flood.get(c.building_id)
             and c.scores_by_use["residential"].legal > 0 and c.est_units][:3]
    assert len(extra) == 3
    r = rs.rescore(p, [Edit(kind="place_tile", tile="convert_residential", target_id=c.building_id) for c in extra], lc.f)
    steps = [r.suggested.scoreboard.embodied_co2_saved_tonnes] + [s.scoreboard.embodied_co2_saved_tonnes for s in r.steps]
    assert all(a < b_ for a, b_ in zip(steps, steps[1:])), steps
    convs = {c["building_id"]: ConversionCandidate.model_validate(c) for c in r.plan_patch["conversions"]}
    total, n = _conv_embodied([Site.model_validate(s) for s in r.plan_patch["sites"]], convs)
    assert r.scoreboard.embodied_co2_saved_tonnes == pytest.approx(total, abs=0.05 * n + 1e-9)


@pytest.mark.parametrize("L", LOCALES)
def test_conversion_sites_carry_their_candidates_units(plans, L):
    lc = _Locale(plans(L))
    for c in lc.p.conversions:
        assert c.est_units == reuse.units_for(lc.buildings[c.building_id].rentable_area_sqft.value, lc.f)
        assert c.est_units is None or c.est_units >= 0
    for s in lc.p.sites:
        if s.kind != "conversion":
            continue
        c = lc.cands[s.building_id]
        assert c.best_use != "keep_current" and c.overall >= lc.f["reuse_feasible_threshold"], s.id
        assert s.homes == rs.conversion_homes(c.best_use, c.est_units, lc.f), s.id


# ---------------------------------------------------------------- legal fit and paths


@pytest.mark.parametrize("L", LOCALES)
def test_conversion_legal_fit_comes_from_cited_conversion_paths(plans, L):
    """A conversion's legal fit is decided by a path that governs conversions (never a new-construction-only path such
    as SB 79), and an allowing verdict carries the citation behind it."""
    lc = _Locale(plans(L))
    for c in lc.p.conversions:
        env = lc.envs.get(lc.buildings[c.building_id].parcel_id)
        paths = {x.name: x for x in conversion_paths(env.paths)} if env else {}
        for use in reuse.CONVERT_USES:
            d = _detail(c, use, "legal", "legal path")
            if d.value is None:
                continue
            assert d.value in paths and not is_new_construction_only(d.value), (c.building_id, d.value)
            if d.score >= 0.5:
                x = paths[d.value]
                assert x.eligible is True and use in x.allows.get("allows_uses", []) and x.citations, (c.building_id, use)
        if c.best_use != "keep_current" and c.scores_by_use[c.best_use].legal >= 0.5:
            assert c.legal_path is not None and c.legal_path.eligible and c.legal_path.citations, c.building_id


@pytest.mark.xfail(strict=True, reason="QA-REUSE-5: buildings with no parcel match are labeled 'not covered by corpus'")
def test_houston_candidates_never_reported_uncovered_by_the_corpus(plans):
    p = plans("houston_downtown")
    assert p.envelopes and all(e.covered for e in p.envelopes)   # Houston development rules cover every parcel
    bad = [c.building_id for c in p.conversions if "legal status not covered by corpus" in c.blockers]
    assert not bad, bad


@pytest.mark.parametrize("L", _xfail(4, "financial inputs without a value carry a model/county confidence, not 'missing'"))
def test_score_inputs_without_a_value_are_labeled_missing(plans, L):
    bad = [(c.building_id, d.use, d.prov.source, d.prov.confidence) for c in plans(L).conversions for d in c.details
           if d.fit in ("physical", "market", "financial") and d.value is None and d.prov.confidence != "missing"]
    assert not bad, f"{len(bad)} inputs, e.g. {bad[:3]}"


def test_brevard_reuse_is_screening_only_and_never_better_than_low_confidence(plans):
    convs = plans("brevard_cocoa").conversions
    assert convs and all(c.screening_only for c in convs)
    assert all(CONF[c.confidence] <= CONF["low"] for c in convs)


# ---------------------------------------------------------------- flood


@pytest.mark.parametrize("L", _xfail(6, "convert tiles (and the reuse agent) add homes inside FEMA high-risk flood zones"))
def test_converting_a_flooded_building_adds_no_homes_in_a_flood_zone(plans, L):
    p = plans(L)
    lc = _Locale(p)
    flooded = sorted((c for c in p.conversions if p.precomputed.in_flood.get(c.building_id)
                      and c.scores_by_use["residential"].legal > 0 and c.est_units), key=lambda c: c.building_id)
    assert flooded
    r = rs.rescore(p, [Edit(kind="place_tile", tile="convert_residential", target_id=flooded[0].building_id)], lc.f)
    assert {t.key: t.value for t in r.steps[-1].targets}["flood_exposure"] == 0
    assert r.rejected is not None


@pytest.mark.parametrize("L", LOCALES)
def test_plan_sites_take_envelope_homes_and_avoid_flood_zones(plans, L):
    p = plans(L)
    hb, flood = p.precomputed.homes_by_parcel, p.precomputed.in_flood
    envs = {e.parcel_id for e in p.envelopes}
    for s in p.sites:
        if not rs.in_plan(s):
            continue
        assert not any(flood.get(x) for x in s.parcel_ids) and not flood.get(rs.site_target(s)), s.id
        if s.kind == "new_build":
            assert set(s.parcel_ids) <= envs, s.id
            assert s.homes == sum(hb.get(x) or 0 for x in s.parcel_ids), s.id
    assert {t.key: t.value for t in p.targets}["flood_exposure"] == 0


# ---------------------------------------------------------------- zoning envelopes and homes_by_parcel


@pytest.mark.parametrize("L", LOCALES)
def test_homes_by_parcel_respects_each_envelopes_limits(plans, L):
    p = plans(L)
    f = resolve(L)
    hb = p.precomputed.homes_by_parcel
    acres = {x.id: x.area_acres.value for x in p.parcels}
    assert all(v is None or v >= 0 for v in hb.values())
    per_unit = f["avg_unit_sqft_residential"]
    for e in p.envelopes:
        a = acres[e.parcel_id]
        sqft = (a or 0) * zoning.SQFT_PER_ACRE
        new = [x for x in e.paths if not is_conversion_only(x.name)]
        for x in e.paths:
            if x.eligible is not True:
                assert x.homes is None, (e.parcel_id, x.name)
        for x in new:
            if x.homes is None:
                continue
            al = x.allows
            assert x.homes >= 0 and not set(LIMITS) & set(al.get("not_covered", [])), (e.parcel_id, x.name)
            if al.get("max_units_per_acre") is not None:
                assert x.homes <= al["max_units_per_acre"] * a + 1e-9, (e.parcel_id, x.name)
            if al.get("max_far") is not None:
                assert x.homes <= al["max_far"] * sqft / per_unit + 1e-9, (e.parcel_id, x.name)
            else:
                stories = (math.floor(al["max_height_ft"] / f["story_height_ft"]) if al.get("max_height_ft") is not None
                           else f["newbuild_assumed_stories"])
                assert x.homes <= sqft * f["site_lot_coverage_ratio"] * stories / per_unit + 1e-9, (e.parcel_id, x.name)
        best = [x.homes for x in new if x.eligible and x.homes]
        assert hb.get(e.parcel_id) == (max(best) if best else None), e.parcel_id
        eligible = [x for x in e.paths if x.eligible is True]
        if not eligible:
            assert e.recommended_path is None, e.parcel_id
        else:
            rec = next(x for x in e.paths if x.name == e.recommended_path)
            assert (rec.homes or 0) == max(x.homes or 0 for x in eligible), e.parcel_id


@pytest.mark.parametrize("L", LOCALES)
def test_homes_for_grows_with_parcel_area_on_each_real_path(plans, L):
    p = plans(L)
    f = resolve(L)
    seen: dict[str, object] = {}
    for e in p.envelopes:
        for x in e.paths:
            if x.eligible is True and not is_conversion_only(x.name):
                seen.setdefault(repr(sorted(x.allows.items(), key=lambda kv: kv[0])), x)
    assert seen
    priced = 0
    for x in seen.values():
        assert zoning.homes_for(0.0, x, f) is None and zoning.homes_for(None, x, f) is None
        homes = [zoning.homes_for(a, x, f) for a in (0.05, 0.25, 0.5, 1.0, 2.0, 4.0)]
        if set(LIMITS) & set(x.allows.get("not_covered", [])):
            assert homes == [None] * len(homes)   # never assume a limit the corpus does not give
            continue
        priced += 1
        assert all(h is not None and h >= 0 for h in homes) and homes[-1] > 0, homes
        assert all(a <= b_ for a, b_ in zip(homes, homes[1:])), homes
    assert priced
