"""Land deal strategy (docs/04 decision rules, in order). Pure."""
from typing import Optional

from backend.schemas import DealStrategy

# Not a numeric factor: owner-name substrings that mark a public agency (case-insensitive).
PUBLIC_OWNER_MARKERS = ["CITY OF", "COUNTY", "STATE OF", "UNITED STATES", "METROPOLITAN TRANSIT",
                        "TRANSIT AUTHORITY", "HOUSING AUTHORITY", "SCHOOL DISTRICT", "REDEVELOPMENT AUTHORITY",
                        "LOS ANGELES COUNTY METROPOLITAN"]
LEASE_UNKNOWN = "lease status unknown, verify before outreach"


def is_public(owner: Optional[str]) -> bool:
    return bool(owner) and any(m in owner.upper() for m in PUBLIC_OWNER_MARKERS)


def deal_strategy(site_id: str, kind: str, owner: Optional[str], lease_expiry_year: Optional[int],
                  vacancy_pct: Optional[float], last_sale_year: Optional[int], current_year: int, f: dict,
                  address: Optional[str], homes: int) -> DealStrategy:
    reasons: list[str] = []
    strategy = None
    if is_public(owner):
        strategy = "joint_development"
        reasons.append(f"public owner ({owner}): partner on joint development")
    if lease_expiry_year is None:
        reasons.append(LEASE_UNKNOWN)
    elif strategy is None and lease_expiry_year - current_year > f["deal_lease_pass_years"]:
        strategy = "pass"
        reasons.append(f"active lease runs to {lease_expiry_year}, more than {f['deal_lease_pass_years']} years out "
                       f"(factor `deal_lease_pass_years`)")
    if strategy is None and kind == "conversion" and vacancy_pct is not None \
            and vacancy_pct <= f["deal_vacancy_for_acquisition"]:
        strategy = "owner_partnership"
        reasons.append(f"building {vacancy_pct:.0f}% vacant, at or under {f['deal_vacancy_for_acquisition']}% "
                       f"(factor `deal_vacancy_for_acquisition`): partner with the owner")
    if strategy is None and last_sale_year is not None and current_year - last_sale_year >= f["deal_long_hold_years"]:
        strategy = "ground_lease"
        reasons.append(f"same owner since {last_sale_year}, {f['deal_long_hold_years']}+ years "
                       f"(factor `deal_long_hold_years`): offer a ground lease")
    if strategy is None:
        strategy = "buy"
        reasons.append("no public owner, long hold or blocking lease found: approach to buy")
    if owner is None:
        reasons.append("owner not in public records; identify before outreach")
    letter = None if strategy == "pass" else _letter(owner, address, kind, strategy, homes)
    return DealStrategy(site_id=site_id, strategy=strategy, reasons=reasons, letter_draft=letter)


def _letter(owner, address, kind, strategy, homes) -> str:
    what = "converting the existing building to homes" if kind == "conversion" else "building new homes"
    ask = {"joint_development": "a joint development partnership", "owner_partnership": "a partnership with you",
           "ground_lease": "a long-term ground lease", "buy": "a purchase"}[strategy]
    return (f"Dear {owner or 'Property Owner'},\n\n"
            f"We are studying the property at {address or 'your parcel'} for {what} near transit "
            f"(about {homes} homes in our preliminary plan). We would like to discuss {ask}.\n\n"
            f"Sincerely,\nTransitor planning team\n\nDRAFT — not sent.")
