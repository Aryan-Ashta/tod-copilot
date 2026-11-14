from backend.models.finance import capital_stack, compare_options, conversion_pro_forma, new_build_pro_forma

F = {"construction_cost_usd_per_unit": 300_000, "rent_usd_per_unit_month": 2000, "vacancy_rate": 0.05,
     "opex_ratio": 0.35, "cap_rate": 0.05, "debt_ratio": 0.6, "max_ltv": 0.75, "affordable_share": 0.2,
     "per_unit_credit_equity_usd": 100_000, "investor_equity_share": 0.1, "conversion_cost_usd_per_sqft": 300,
     "affordable_rent_usd_per_unit_month": 2000}  # = market rent, so the hand checks below isolate the stack


def test_new_build_stack_hand_checked():
    pf = new_build_pro_forma(100, 5_000_000, F, incentive_per_unit=15_000)
    assert pf["total_cost_usd"] == 35_000_000
    assert pf["noi_usd"] == 100 * 2000 * 12 * 0.6 == 1_440_000
    assert pf["value_usd"] == 28_800_000
    stack, m = capital_stack("s", pf, F, 15_000)
    assert stack.debt_usd == 21_000_000          # min(0.6 x 35M, 0.75 x 28.8M = 21.6M)
    assert stack.incentive_usd == 1_500_000
    assert stack.tax_credit_equity_usd == 2_000_000  # 20 affordable units x 100k
    assert stack.investor_equity_usd == 3_500_000
    assert stack.gap_usd == 35_000_000 - 21_000_000 - 1_500_000 - 2_000_000 - 3_500_000 == 7_000_000
    assert stack.pencils is False


def test_conversion_and_compare():
    conv = conversion_pro_forma(100, 5_000_000, 100_000, F)
    assert conv["total_cost_usd"] == 35_000_000
    nb = new_build_pro_forma(100, 5_000_000, F)
    assert compare_options(nb, conv) == "conversion"  # tie -> conversion
    assert new_build_pro_forma(10, None, F) is None


def test_gap_to_pencil_levers_each_close_the_gap():
    f = {**F, "debt_ratio": 0.87}                     # loan-to-value binds: min(30.45M, 0.75 x 28.8M = 21.6M)
    stack, _ = capital_stack("s", new_build_pro_forma(100, 5_000_000, f, 15_000), f, 15_000)
    g = stack.gap_to_pencil
    assert stack.gap_usd == 6_400_000 and g.debt_limit == "loan_to_value"
    assert g.gap_per_home_usd == 64_000 and g.cost_per_home_usd == 350_000 and g.value_per_home_usd == 288_000
    closed, _ = capital_stack("s", new_build_pro_forma(100, 5_000_000, f), f, 15_000 + g.gap_per_home_usd)
    assert abs(closed.gap_usd) < 1 and closed.gap_to_pencil is None
    rent_f = {**f, "rent_usd_per_unit_month": g.break_even_rent_usd_per_unit_month}
    closed, _ = capital_stack("s", new_build_pro_forma(100, 5_000_000, rent_f), rent_f, 15_000)
    assert abs(closed.gap_usd) < 1


def test_gap_to_pencil_rent_cannot_close_when_loan_to_cost_binds():
    stack, _ = capital_stack("s", new_build_pro_forma(100, 5_000_000, F, 15_000), F, 15_000)
    assert stack.gap_to_pencil.debt_limit == "loan_to_cost"
    assert stack.gap_to_pencil.break_even_rent_usd_per_unit_month is None
    assert stack.gap_to_pencil.gap_per_home_usd == 70_000


def test_affordable_homes_rent_at_the_affordable_limit():
    f = {**F, "affordable_rent_usd_per_unit_month": 1000, "debt_ratio": 0.87}
    pf = new_build_pro_forma(100, 5_000_000, f)
    assert pf["noi_usd"] == (80 * 2000 + 20 * 1000) * 12 * 0.6 == 1_296_000  # 20 affordable homes (share 0.2)
    g = capital_stack("s", pf, f)[0].gap_to_pencil
    closed_f = {**f, "rent_usd_per_unit_month": g.break_even_rent_usd_per_unit_month}
    closed, _ = capital_stack("s", new_build_pro_forma(100, 5_000_000, closed_f), closed_f)
    assert abs(closed.gap_usd) < 1  # break-even moves only the 80 market-rate rents
