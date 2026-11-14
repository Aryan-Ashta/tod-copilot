"""Runtime settings loaded from `.env` (git-ignored). Names only live in `.env.example`."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OFFLINE = os.getenv("DEMO_OFFLINE") == "1"
LLM_ENABLED = bool(ANTHROPIC_API_KEY) and not OFFLINE and os.getenv("TOD_LLM", "1") != "0"
MODEL = os.getenv("TOD_MODEL", "anthropic:claude-sonnet-4-6")
NREL_API_KEY = os.getenv("NREL_API_KEY", "DEMO_KEY")
REPLAY_DELAY_S = float(os.getenv("REPLAY_DELAY_S", "0.25"))

CACHE_DIR = ROOT / "cache"
FIXTURES_DIR = ROOT / "backend" / "fixtures"
CORPUS_DIR = ROOT / "backend" / "corpus"
