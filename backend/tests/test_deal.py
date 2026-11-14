from backend.models.deal import LEASE_UNKNOWN, deal_strategy

F = {"deal_lease_pass_years": 3, "deal_vacancy_for_acquisition": 50, "deal_long_hold_years": 20}


def d(**kw):
    args = dict(site_id="s", kind="new_build", owner="ACME LLC", lease_expiry_year=None, vacancy_pct=None,
                last_sale_year=None, current_year=2026, f=F, address="1 Main", homes=10)
    args.update(kw)
    return deal_strategy(**args)


def test_rule_order():
    assert d(owner="CITY OF HOUSTON").strategy == "joint_development"
    assert d(lease_expiry_year=2031).strategy == "pass"
    assert d(lease_expiry_year=2028, kind="conversion", vacancy_pct=30).strategy == "owner_partnership"
    assert d(lease_expiry_year=2028, kind="conversion", vacancy_pct=80, last_sale_year=2000).strategy == "ground_lease"
    assert d(lease_expiry_year=2028).strategy == "buy"


def test_missing_lease_note_and_draft():
    r = d()
    assert LEASE_UNKNOWN in r.reasons and r.letter_draft.endswith("DRAFT — not sent.")
