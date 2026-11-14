"""Runtime settings from the environment. Secrets come from Doppler (project tod-copilot, config prd), injected by
`doppler run -- <command>`; a git-ignored `.env` fills only variables Doppler did not set (load_dotenv never
overrides). Names only live in `.env.example`."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OFFLINE = os.getenv("DEMO_OFFLINE") == "1"
LLM_ENABLED = bool(ANTHROPIC_API_KEY) and not OFFLINE and os.getenv("TOD_LLM", "1") != "0"
MODEL = os.getenv("TOD_MODEL", "anthropic:claude-haiku-5-5")   # docs/model-eval.md (2026-11-14)
NREL_API_KEY = os.getenv("NREL_API_KEY", "DEMO_KEY")
REPLAY_DELAY_S = float(os.getenv("REPLAY_DELAY_S", "0.25"))

# LangSmith tracing (optional): on when a key is set and not offline. Inputs and outputs are hidden so licensed
# CoStar/Matterport/Vexcel values in tool calls never leave this machine; traces keep structure, timing and tokens.
LANGSMITH_ENABLED = bool(os.getenv("LANGSMITH_API_KEY")) and not OFFLINE
if LANGSMITH_ENABLED:
    os.environ.setdefault("LANGSMITH_TRACING", "true")
    os.environ.setdefault("LANGSMITH_PROJECT", "tod-copilot")
    os.environ["LANGSMITH_HIDE_INPUTS"] = "true"
    os.environ["LANGSMITH_HIDE_OUTPUTS"] = "true"
else:   # offline demo: never try to upload traces
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"

CACHE_DIR = ROOT / "cache"
FIXTURES_DIR = ROOT / "backend" / "fixtures"
CORPUS_DIR = ROOT / "backend" / "corpus"
