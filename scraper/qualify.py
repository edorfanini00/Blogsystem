"""
qualify.py — Claude AI Lead Qualification Engine

Takes scouted company data and campaign criteria, asks Claude to 
score and qualify the lead, and returns structured qualification data.
"""

import json
import logging
import os
from typing import Any

from anthropic import Anthropic

from . import config

logger = logging.getLogger(__name__)

# ── Claude Client ─────────────────────────────────────────────────

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    """Lazy-initialize the Anthropic client."""
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY") or config.ANTHROPIC_API_KEY
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set in environment")
        _client = Anthropic(api_key=api_key)
    return _client


# ── Qualification Prompt ──────────────────────────────────────────

SYSTEM_PROMPT = """You are a B2B lead qualification expert for Celeritech, a company that sells 
ERP (Enterprise Resource Planning) solutions specifically designed for food and beverage manufacturers.

Your job is to analyze company data and determine how well they match as a potential customer.

Celeritech's ideal customer profile:
- Food & beverage manufacturer (dairy, bakery, meat processing, seafood, snacks, beverages, frozen foods, etc.)
- Mid-market: 20-200 employees
- Revenue: $5M - $100M
- Currently using basic tools (QuickBooks, spreadsheets, manual processes) — NOT already on enterprise ERP (SAP, Oracle, NetSuite)
- Has quality certifications (SQF, HACCP, FDA, USDA) indicating operational maturity
- Based in the United States

SCORING RULES (0-100 scale):
+25 points: Confirmed food & beverage manufacturer
+20 points: Employee count within target range (20-200)
+15 points: Revenue within target range ($5M-$100M)  
+15 points: No enterprise ERP detected / uses basic software (QuickBooks, spreadsheets)
+10 points: Contact email for decision-maker found
+5 points:  Has quality certifications (SQF, HACCP, FDA, etc.)
+5 points:  Multiple locations or facilities
+5 points:  Decision-maker name and title identified

DISQUALIFIERS (set score to 0, fit_level to "disqualified"):
- NOT a manufacturer (e.g., restaurant, retailer, distributor only)
- Already uses enterprise ERP (SAP, Oracle, NetSuite, Microsoft Dynamics 365, Epicor)
- Fewer than 10 employees (too small)
- More than 500 employees (too large for our offering)
- Not in the food & beverage industry

You MUST respond with valid JSON only. No explanation text outside the JSON."""

USER_PROMPT_TEMPLATE = """Analyze this company and return a JSON qualification assessment.

COMPANY DATA:
{company_data}

CAMPAIGN CRITERIA:
- Target industry: {industry}
- Target sub-categories: {sub_categories}
- Target employee range: {emp_min} - {emp_max}
- Target revenue range: ${rev_min:,} - ${rev_max:,}

Return this exact JSON structure:
{{
  "score": <0-100 integer>,
  "fit_level": "<high|medium|low|disqualified>",
  "reasoning": "<2-3 sentence explanation of the score>",
  "estimated_employees": <number or null>,
  "estimated_revenue": "<string like '$18M' or null>",
  "current_software": ["<list of detected software>"],
  "pain_points": ["<likely pain points based on company profile>"],
  "decision_makers": [
    {{"name": "<name>", "title": "<title>", "email": "<email>"}}
  ],
  "recommended_approach": "<cold_email|cold_call|linkedin|skip>",
  "personalized_email_draft": {{
    "subject": "<personalized subject line>",
    "body": "<personalized cold email body, 150-200 words, professional but warm>"
  }}
}}

IMPORTANT: 
- The email should reference specific details about their company (products, certifications, location)
- Mention Celeritech by name and how ERP can solve their likely pain points
- Include a clear call to action (schedule a demo/call)
- Keep the tone professional but conversational
- The subject line should be attention-grabbing and personalized"""


# ── Qualification Function ────────────────────────────────────────

async def qualify_lead(
    scouted_data: dict[str, Any],
    campaign_config: dict[str, Any],
) -> dict[str, Any]:
    """
    Qualify a scouted lead using Claude AI.
    
    Args:
        scouted_data: Company data from the scout module
        campaign_config: Campaign targeting criteria
        
    Returns:
        Qualification dict with score, reasoning, email draft, etc.
    """
    try:
        client = _get_client()
    except RuntimeError as e:
        logger.error(f"Cannot qualify lead — {e}")
        return _fallback_qualification(scouted_data, campaign_config)

    # Build the company data summary for Claude
    company_summary = _format_company_data(scouted_data)
    
    # Extract campaign criteria
    config = campaign_config.get("config", campaign_config)
    industry = config.get("industry", "Food & Beverage Manufacturing")
    sub_categories = ", ".join(config.get("subCategories", []))
    emp_range = config.get("employeeRange", {})
    rev_range = config.get("revenueRange", {})
    
    user_prompt = USER_PROMPT_TEMPLATE.format(
        company_data=company_summary,
        industry=industry,
        sub_categories=sub_categories or "All",
        emp_min=emp_range.get("min", 20),
        emp_max=emp_range.get("max", 200),
        rev_min=rev_range.get("min", 5_000_000),
        rev_max=rev_range.get("max", 100_000_000),
    )

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        
        # Extract text response
        text = response.content[0].text.strip()
        
        # Parse JSON — handle potential markdown code blocks
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()
        
        qualification = json.loads(text)
        
        # Validate required fields
        qualification.setdefault("score", 0)
        qualification.setdefault("fit_level", "low")
        qualification.setdefault("reasoning", "")
        qualification.setdefault("estimated_employees", None)
        qualification.setdefault("estimated_revenue", None)
        qualification.setdefault("current_software", [])
        qualification.setdefault("pain_points", [])
        qualification.setdefault("decision_makers", [])
        qualification.setdefault("recommended_approach", "cold_email")
        qualification.setdefault("personalized_email_draft", {"subject": "", "body": ""})
        
        # Ensure score is an integer 0-100
        qualification["score"] = max(0, min(100, int(qualification["score"])))
        
        # Map fit_level based on score if not already set correctly
        score = qualification["score"]
        if score >= 75:
            qualification["fit_level"] = "high"
        elif score >= 50:
            qualification["fit_level"] = "medium"
        elif score > 0:
            qualification["fit_level"] = "low"
        else:
            qualification["fit_level"] = "disqualified"
        
        logger.info(
            f"Qualified lead: {scouted_data.get('name', 'Unknown')} — "
            f"Score: {qualification['score']}, Fit: {qualification['fit_level']}"
        )
        
        return qualification

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Claude response as JSON: {e}")
        return _fallback_qualification(scouted_data, campaign_config)
    except Exception as e:
        logger.error(f"Claude API error during qualification: {e}")
        return _fallback_qualification(scouted_data, campaign_config)


# ── Helpers ───────────────────────────────────────────────────────

def _format_company_data(data: dict[str, Any]) -> str:
    """Format scouted data into a readable summary for Claude."""
    lines = []
    
    if data.get("name"):
        lines.append(f"Company Name: {data['name']}")
    if data.get("website"):
        lines.append(f"Website: {data['website']}")
    if data.get("address"):
        lines.append(f"Address: {data['address']}")
    if data.get("phone"):
        lines.append(f"Phone: {data['phone']}")
    if data.get("category"):
        lines.append(f"Google Maps Category: {data['category']}")
    if data.get("rating"):
        lines.append(f"Google Rating: {data['rating']} ({data.get('review_count', '?')} reviews)")
    
    # Scouted data
    scouting = data.get("scouting", {})
    if scouting.get("description"):
        lines.append(f"Description: {scouting['description']}")
    if scouting.get("employee_mentions"):
        lines.append(f"Employee mentions found: {scouting['employee_mentions']}")
    if scouting.get("revenue_mentions"):
        lines.append(f"Revenue mentions found: {scouting['revenue_mentions']}")
    if scouting.get("emails"):
        lines.append(f"Emails found: {', '.join(scouting['emails'][:5])}")
    if scouting.get("phones"):
        lines.append(f"Phones found: {', '.join(scouting['phones'][:3])}")
    if scouting.get("people"):
        people_str = "; ".join(
            f"{p.get('name', '?')} ({p.get('title', '?')})" 
            for p in scouting["people"][:5]
        )
        lines.append(f"People found: {people_str}")
    if scouting.get("certifications"):
        lines.append(f"Certifications: {', '.join(scouting['certifications'])}")
    if scouting.get("software_detected"):
        lines.append(f"Software detected: {', '.join(scouting['software_detected'])}")
    if scouting.get("products"):
        lines.append(f"Products/Services: {', '.join(scouting['products'][:10])}")
    if scouting.get("social_links"):
        social = scouting["social_links"]
        if social.get("linkedin"):
            lines.append(f"LinkedIn: {social['linkedin']}")
        if social.get("facebook"):
            lines.append(f"Facebook: {social['facebook']}")
    if scouting.get("tech_stack"):
        lines.append(f"Website tech: {scouting['tech_stack']}")
    if scouting.get("locations"):
        lines.append(f"Number of locations: {scouting['locations']}")
    
    return "\n".join(lines) if lines else "Minimal data available — only basic directory listing."


def _fallback_qualification(
    data: dict[str, Any],
    campaign_config: dict[str, Any],
) -> dict[str, Any]:
    """
    Rule-based fallback qualification when Claude is unavailable.
    Uses simple heuristics to score the lead.
    """
    score = 0
    reasons = []
    
    name = (data.get("name") or "").lower()
    category = (data.get("category") or "").lower()
    scouting = data.get("scouting", {})
    
    # Check if F&B related
    fb_keywords = [
        "food", "beverage", "dairy", "bakery", "baking", "meat", "poultry",
        "seafood", "snack", "frozen", "sauce", "condiment", "brewing",
        "distill", "bottling", "packaging", "processing", "manufacturer",
        "creamery", "confection", "candy", "chocolate", "grain", "flour",
        "produce", "organic", "nutrition", "supplement", "pet food",
    ]
    text_to_check = f"{name} {category} {scouting.get('description', '')}"
    if any(kw in text_to_check for kw in fb_keywords):
        score += 25
        reasons.append("Food & beverage related keywords detected")
    
    # Check certifications
    certs = scouting.get("certifications", [])
    if certs:
        score += 5
        reasons.append(f"Has certifications: {', '.join(certs[:3])}")
    
    # Check for enterprise ERP (negative signal)
    software = scouting.get("software_detected", [])
    enterprise_erp = ["sap", "oracle", "netsuite", "dynamics 365", "epicor"]
    if any(erp in s.lower() for s in software for erp in enterprise_erp):
        score = 0
        reasons = ["DISQUALIFIED: Already uses enterprise ERP"]
    elif software:
        basic_tools = ["quickbooks", "excel", "spreadsheet", "sage 50"]
        if any(t in s.lower() for s in software for t in basic_tools):
            score += 15
            reasons.append("Uses basic software — good ERP candidate")
    
    # Check for contact info
    if scouting.get("emails"):
        score += 10
        reasons.append("Contact email found")
    
    if scouting.get("people"):
        score += 5
        reasons.append("Decision-maker identified")
    
    # Determine fit level
    fit_level = "disqualified" if score == 0 else (
        "high" if score >= 75 else "medium" if score >= 50 else "low"
    )
    
    # Extract contacts
    decision_makers = []
    for person in scouting.get("people", [])[:3]:
        decision_makers.append({
            "name": person.get("name", ""),
            "title": person.get("title", ""),
            "email": person.get("email", ""),
        })
    
    return {
        "score": score,
        "fit_level": fit_level,
        "reasoning": "; ".join(reasons) if reasons else "Insufficient data for qualification",
        "estimated_employees": None,
        "estimated_revenue": None,
        "current_software": software,
        "pain_points": [],
        "decision_makers": decision_makers,
        "recommended_approach": "cold_email" if score >= 50 else "skip",
        "personalized_email_draft": {"subject": "", "body": ""},
        "_note": "Fallback rule-based qualification (Claude unavailable)",
    }
