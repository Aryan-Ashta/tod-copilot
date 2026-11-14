from backend.agents.plan_options import parse_prompt, stock_prompts
from backend.data.locales import LOCALE_IDS
from backend.schemas import PlanOptions


def test_parse_focus():
    assert parse_prompt("Find office buildings that could become housing").focus == "conversions"
    assert parse_prompt("Turn surface lots along the Main Street rail into homes").focus == "new_build"
    assert parse_prompt("Compare SB 79 new construction with adaptive reuse").focus == "all"


def test_budget_and_affordable_words_do_not_set_goals():
    # goals come from numeric fields only, never from the prompt
    assert parse_prompt("Maximize affordable housing on a small budget") == PlanOptions()
    assert parse_prompt("Plan TOD around the stations") == PlanOptions()


def test_stock_prompts_valid():
    ps = stock_prompts()
    assert len({p.id for p in ps}) == len(ps)
    assert all(p.locale_id is None or p.locale_id in LOCALE_IDS for p in ps)


def test_stock_prompt_text_parses_to_its_options():
    # the UI re-parses the textarea after a chip fills it; the chip's options must survive that
    for p in stock_prompts():
        assert parse_prompt(p.prompt).focus == p.options.focus, p.id
