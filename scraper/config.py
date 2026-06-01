"""
Celeritech Orbit — Configuration & Constants
=============================================
Loads environment variables from the parent server/.env and defines
default templates, scoring weights, and operational constants used
across the scraping service.
"""

from __future__ import annotations

import os
import logging
from pathlib import Path

from dotenv import load_dotenv

# ── Load .env from parent server/ directory (shared with Node.js) ──
_ENV_PATH = Path(__file__).resolve().parent.parent / "server" / ".env"
load_dotenv(dotenv_path=_ENV_PATH, override=False)

logger = logging.getLogger("orbit.config")

# ─── API Keys & External Services ─────────────────────────────────
ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
REDIS_URL: str = os.getenv("KV_URL", "") or os.getenv("REDIS_URL", "")
NODE_SERVER_URL: str = os.getenv("NODE_SERVER_URL", "http://localhost:3001")
EMAIL_USER: str = os.getenv("EMAIL_USER", "")
EMAIL_PASSWORD: str = os.getenv("EMAIL_PASSWORD", "")

# ─── Service Configuration ────────────────────────────────────────
SCRAPER_PORT: int = int(os.getenv("SCRAPER_PORT", "3002"))
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

# ─── Rate Limiting ────────────────────────────────────────────────
RATE_LIMIT_MIN_SECONDS: float = 3.0
RATE_LIMIT_MAX_SECONDS: float = 8.0
MAPS_RATE_LIMIT_MIN: float = 5.0
MAPS_RATE_LIMIT_MAX: float = 10.0
MAX_CONCURRENT_SCOUTS: int = 3
MAX_PAGES_PER_SOURCE: int = 5

# ─── Default Industry Templates ──────────────────────────────────
# Celeritech targets Food & Beverage manufacturers for ERP sales.
INDUSTRY_SUBCATEGORIES: dict[str, list[str]] = {
    "Food & Beverage": [
        "Dairy",
        "Bakery",
        "Meat Processing",
        "Seafood",
        "Snack Foods",
        "Beverage",
        "Frozen Foods",
        "Condiments & Sauces",
        "Pet Food",
        "Supplements",
    ],
}

# Human-readable labels for the UI
SUBCATEGORY_KEYWORDS: dict[str, list[str]] = {
    "Dairy": [
        "dairy manufacturer", "cheese producer", "milk processing plant",
        "yogurt manufacturer", "butter producer",
    ],
    "Bakery": [
        "bakery manufacturer", "bread factory", "commercial bakery",
        "pastry manufacturer", "baked goods producer",
    ],
    "Meat Processing": [
        "meat processing plant", "meat packing company", "sausage manufacturer",
        "poultry processing", "beef processor",
    ],
    "Seafood": [
        "seafood processor", "fish processing plant", "shrimp processing",
        "seafood manufacturer", "canned fish producer",
    ],
    "Snack Foods": [
        "snack food manufacturer", "chip manufacturer", "cracker producer",
        "nut processing", "snack company",
    ],
    "Beverage": [
        "beverage manufacturer", "juice company", "soft drink producer",
        "brewery", "water bottling plant",
    ],
    "Frozen Foods": [
        "frozen food manufacturer", "frozen meals producer",
        "ice cream manufacturer", "frozen vegetables processor",
    ],
    "Condiments & Sauces": [
        "sauce manufacturer", "condiment producer", "spice manufacturer",
        "dressing manufacturer", "hot sauce company",
    ],
    "Pet Food": [
        "pet food manufacturer", "dog food producer", "cat food manufacturer",
        "animal feed company", "pet treat manufacturer",
    ],
    "Supplements": [
        "supplement manufacturer", "vitamin producer", "nutraceutical company",
        "dietary supplement manufacturer", "protein powder manufacturer",
    ],
}

# ─── Search Query Templates ──────────────────────────────────────
SEARCH_QUERY_TEMPLATES: list[str] = [
    "{keyword} near {city}, {state}",
    "{keyword} in {state}",
    "{keyword} companies {city} {state}",
    '"{keyword}" manufacturer {state}',
]

GOOGLE_SEARCH_TEMPLATES: list[str] = [
    "{keyword} {city} {state}",
    "{keyword} company {state}",
    '"{keyword}" manufacturer contact',
    "site:linkedin.com {keyword} {city}",
]

# ─── Lead Scoring Weights ────────────────────────────────────────
SCORING_WEIGHTS: dict[str, int] = {
    "industry_match":       25,  # Confirmed F&B manufacturer
    "employee_range":       20,  # Within target employee count
    "revenue_range":        15,  # Within target revenue range
    "website_quality":      10,  # Has a professional website
    "contact_info":         10,  # Email / phone found
    "decision_maker":        5,  # Identified key decision-maker
    "current_software":      5,  # Using outdated / no ERP
    "certifications":        5,  # FDA, HACCP, etc.
    "growth_signals":        5,  # Hiring, expanding, new products
}

# ─── US States ────────────────────────────────────────────────────
US_STATES: list[dict[str, str]] = [
    {"abbr": "AL", "name": "Alabama"},   {"abbr": "AK", "name": "Alaska"},
    {"abbr": "AZ", "name": "Arizona"},   {"abbr": "AR", "name": "Arkansas"},
    {"abbr": "CA", "name": "California"},{"abbr": "CO", "name": "Colorado"},
    {"abbr": "CT", "name": "Connecticut"},{"abbr": "DE", "name": "Delaware"},
    {"abbr": "FL", "name": "Florida"},   {"abbr": "GA", "name": "Georgia"},
    {"abbr": "HI", "name": "Hawaii"},    {"abbr": "ID", "name": "Idaho"},
    {"abbr": "IL", "name": "Illinois"},  {"abbr": "IN", "name": "Indiana"},
    {"abbr": "IA", "name": "Iowa"},      {"abbr": "KS", "name": "Kansas"},
    {"abbr": "KY", "name": "Kentucky"},  {"abbr": "LA", "name": "Louisiana"},
    {"abbr": "ME", "name": "Maine"},     {"abbr": "MD", "name": "Maryland"},
    {"abbr": "MA", "name": "Massachusetts"},{"abbr": "MI", "name": "Michigan"},
    {"abbr": "MN", "name": "Minnesota"},{"abbr": "MS", "name": "Mississippi"},
    {"abbr": "MO", "name": "Missouri"}, {"abbr": "MT", "name": "Montana"},
    {"abbr": "NE", "name": "Nebraska"}, {"abbr": "NV", "name": "Nevada"},
    {"abbr": "NH", "name": "New Hampshire"},{"abbr": "NJ", "name": "New Jersey"},
    {"abbr": "NM", "name": "New Mexico"},{"abbr": "NY", "name": "New York"},
    {"abbr": "NC", "name": "North Carolina"},{"abbr": "ND", "name": "North Dakota"},
    {"abbr": "OH", "name": "Ohio"},      {"abbr": "OK", "name": "Oklahoma"},
    {"abbr": "OR", "name": "Oregon"},    {"abbr": "PA", "name": "Pennsylvania"},
    {"abbr": "RI", "name": "Rhode Island"},{"abbr": "SC", "name": "South Carolina"},
    {"abbr": "SD", "name": "South Dakota"},{"abbr": "TN", "name": "Tennessee"},
    {"abbr": "TX", "name": "Texas"},     {"abbr": "UT", "name": "Utah"},
    {"abbr": "VT", "name": "Vermont"},   {"abbr": "VA", "name": "Virginia"},
    {"abbr": "WA", "name": "Washington"},{"abbr": "WV", "name": "West Virginia"},
    {"abbr": "WI", "name": "Wisconsin"}, {"abbr": "WY", "name": "Wyoming"},
]

# Top cities per state for search diversification
TOP_CITIES: dict[str, list[str]] = {
    "CA": ["Los Angeles", "San Francisco", "San Diego", "Sacramento", "Fresno"],
    "TX": ["Houston", "Dallas", "San Antonio", "Austin", "Fort Worth"],
    "NY": ["New York City", "Buffalo", "Rochester", "Albany", "Syracuse"],
    "FL": ["Miami", "Orlando", "Tampa", "Jacksonville", "Fort Lauderdale"],
    "IL": ["Chicago", "Aurora", "Naperville", "Rockford", "Joliet"],
    "PA": ["Philadelphia", "Pittsburgh", "Allentown", "Erie", "Reading"],
    "OH": ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Akron"],
    "GA": ["Atlanta", "Augusta", "Savannah", "Columbus", "Macon"],
    "NC": ["Charlotte", "Raleigh", "Greensboro", "Durham", "Winston-Salem"],
    "MI": ["Detroit", "Grand Rapids", "Warren", "Sterling Heights", "Lansing"],
    "NJ": ["Newark", "Jersey City", "Paterson", "Elizabeth", "Edison"],
    "WI": ["Milwaukee", "Madison", "Green Bay", "Kenosha", "Racine"],
    "WA": ["Seattle", "Spokane", "Tacoma", "Vancouver", "Bellevue"],
    "MN": ["Minneapolis", "Saint Paul", "Rochester", "Duluth", "Bloomington"],
    "IN": ["Indianapolis", "Fort Wayne", "Evansville", "South Bend", "Carmel"],
    "MO": ["Kansas City", "St. Louis", "Springfield", "Columbia", "Independence"],
}

# Fallback city if state not in TOP_CITIES
DEFAULT_CITY: str = "metropolitan area"

# ─── Certifications & Software to Detect ──────────────────────────
TARGET_CERTIFICATIONS: list[str] = [
    "SQF", "HACCP", "FDA", "USDA", "ISO", "GMP", "BRC",
    "organic", "GFSI", "FSSC 22000", "IFS", "kosher", "halal",
]

COMPETITOR_SOFTWARE: list[str] = [
    "SAP", "Oracle", "NetSuite", "QuickBooks", "Sage",
    "Microsoft Dynamics", "Dynamics 365", "Epicor", "Infor",
    "Fishbowl", "SYSPRO", "Aptean", "BatchMaster", "Plex",
    "Deacom", "ProcessPro", "JustFood", "Produce Pro",
]

# ─── Logging Setup Helper ────────────────────────────────────────
def setup_logging() -> None:
    """Configure root logging for the entire service."""
    level = getattr(logging, LOG_LEVEL.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s  %(levelname)-8s  [%(name)s]  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Quiet down noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("scrapling").setLevel(logging.WARNING)
