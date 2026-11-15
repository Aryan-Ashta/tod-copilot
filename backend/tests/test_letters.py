import pytest

from backend.models.deal import deal_strategy
from backend.models.letters import LetterTargetNotFound, draft_letter, fmt_figure
from backend.schemas import Citation, LegalPath, ZoningEnvelope
from backend.tests.test_rescore import plan_with_network

C1 = Citation(doc_id="ca_sb79_2025", section="Gov. Code § 65912.157",
              quote="A local government shall not impose any height limit less than 75 feet.", url="https://x")
C2 = Citation(doc_id="ca_gov_code_65913_4", section="Gov. Code § 65913.4(c)", quote="the local government shall "
              "approve the development. " + "word " * 80, url=None, status="agent_verified")
PATH = LegalPath(name="SB 79 new construction", eligible=True, homes=118, citations=[C1, C2, C1],
                 allows={"allows_uses": ["residential"], "max_height_ft": 75, "max_far": 3.5, "discretionary": False})
OTHER = LegalPath(name="Other path", eligible=True, allows={},
                  citations=[Citation(doc_id="other", section="1", quote="not recommended", url=None)])


@pytest.fixture(scope="module")
def plan_f():
    plan, f = plan_with_network(40, 5)
    parcels = {p.id: p for p in plan.parcels}
    deals = []
    for s in plan.sites:
        p = parcels[s.parcel_ids[0]]
        deals.append(deal_strategy(s.id, s.kind, p.owner.value, p.lease_expiry_year.value, None,
                                   p.last_sale_year.value, 2026, f, p.address.value, s.homes))
    deals[1] = deals[1].model_copy(update={"strategy": "pass", "letter_draft": None})
    envs = [ZoningEnvelope(parcel_id="p3", paths=[OTHER, PATH], recommended_path=PATH.name, covered=True),
            ZoningEnvelope(parcel_id="p4", paths=[], recommended_path=None, covered=False)]
    return plan.model_copy(update={"deals": deals, "envelopes": envs}), f


def figures_in_body(d):
    assert d.refusal is None and d.figures
    for k, v in d.figures.items():
        assert fmt_figure(k, v) in d.body, k


def test_owner_outreach(plan_f):
    plan, f = plan_f
    s = plan.sites[0]
    d = draft_letter(plan, "owner_outreach", s.id, f)
    figures_in_body(d)
    assert d.figures == {"homes": float(s.homes)}
    assert d.to == "ACME" and d.body.startswith("Dear ACME,")
    assert "1 Main" in d.body and "1 Main" in d.subject           # site s0 sits on parcel p1
    assert "a long-term ground lease" in d.body                    # same owner since 2000: ground lease
    assert d.body.endswith("Transitor planning team\n\nDRAFT — not sent.") and d.citations == []


def test_owner_outreach_pass_refuses(plan_f):
    plan, f = plan_f
    d = draft_letter(plan, "owner_outreach", plan.sites[1].id, f)
    assert d.refusal and "pass" in d.refusal and d.body == "" and d.figures == {}


def test_pre_application_cites_only_the_recommended_path(plan_f):
    plan, f = plan_f
    d = draft_letter(plan, "pre_application", "p3", f)
    figures_in_body(d)
    assert d.to == "Planning Department, Houston" and "SB 79 new construction" in d.subject
    assert d.figures == {"homes": 118.0, "allows.max_height_ft": 75.0, "allows.max_far": 3.5}
    assert d.citations == [C1, C2]                                  # deduped, recommended path only
    assert "not recommended" not in d.body
    for c in d.citations:
        assert f"{c.doc_id}, {c.section}" in d.body
    assert C1.quote in d.body and C2.quote[:200] in d.body and "…" in d.body   # long quote cut, still verbatim
    for line in ("- allows_uses: residential", "- max_height_ft: 75", "- max_far: 3.5", "- discretionary: no"):
        assert line in d.body


def test_pre_application_refusals(plan_f):
    plan, f = plan_f
    uncovered = draft_letter(plan, "pre_application", "p4", f)
    assert uncovered.refusal and "does not cover" in uncovered.refusal and uncovered.body == ""
    assert uncovered.citations == []
    assert draft_letter(plan, "pre_application", "p10", f).refusal     # parcel without an envelope
    with pytest.raises(LetterTargetNotFound):
        draft_letter(plan, "pre_application", "nope", f)


def test_funding_request(plan_f):
    plan, f = plan_f
    st = plan.stacks[0]
    d = draft_letter(plan, "funding_request", st.site_id, f)
    figures_in_body(d)
    assert d.to == "Housing finance agency"
    assert d.figures["units"] == st.units and d.figures["affordable_units"] == st.affordable_units
    assert d.figures["total_cost_usd"] == round(st.total_cost_usd)
    assert d.figures["debt_usd"] == round(st.debt_usd)
    assert d.figures["tax_credit_equity_usd"] == round(st.tax_credit_equity_usd)
    assert d.figures["funding_required_usd"] == round(max(st.funding_required_usd, 0))
    assert f"Total development cost: ${round(st.total_cost_usd):,}" in d.body


def test_funding_request_without_stack_refuses_and_unknown_site_raises(plan_f):
    plan, f = plan_f
    bare = plan.model_copy(update={"stacks": []})
    d = draft_letter(bare, "funding_request", plan.sites[0].id, f)
    assert d.refusal and d.body == "" and d.figures == {}
    with pytest.raises(LetterTargetNotFound):
        draft_letter(plan, "funding_request", "nope", f)
    with pytest.raises(LetterTargetNotFound):
        draft_letter(plan, "owner_outreach", "nope", f)
