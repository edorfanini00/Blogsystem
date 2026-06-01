"""
Celeritech Orbit — Website Scouting Engine
============================================
Takes a company website URL and thoroughly scrapes it for business
intelligence: emails, phones, team/people, employee count, revenue,
certifications, current software, social links, and products.

Uses Scrapling Fetcher with stealthy_headers.  Each sub-page is
fetched independently so a single 404 never stops the whole scout.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

from scrapling import Fetcher

from scraper.config import (
    COMPETITOR_SOFTWARE,
    MAX_CONCURRENT_SCOUTS,
    RATE_LIMIT_MAX_SECONDS,
    RATE_LIMIT_MIN_SECONDS,
    TARGET_CERTIFICATIONS,
)

logger = logging.getLogger("orbit.scout")

# Pages to scout on every company website
_SCOUT_PATHS: list[str] = [
    "/",
    "/about",
    "/about-us",
    "/contact",
    "/contact-us",
    "/team",
    "/our-team",
    "/products",
    "/careers",
]

# ── Regex Patterns ─────────────────────────────────────────────────
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.IGNORECASE)
_US_PHONE_RE = re.compile(
    r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}"
)
_EMPLOYEE_RE = re.compile(r"(\d[\d,]*)\+?\s*employees?", re.IGNORECASE)
_REVENUE_RE = re.compile(
    r"\$\s*([\d,.]+)\s*(million|billion|M|B|m|b)", re.IGNORECASE
)
_SOCIAL_PATTERNS: dict[str, re.Pattern] = {
    "linkedin": re.compile(r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[^\s\"'<>]+", re.I),
    "facebook": re.compile(r"https?://(?:www\.)?facebook\.com/[^\s\"'<>]+", re.I),
    "twitter": re.compile(r"https?://(?:www\.)?(?:twitter|x)\.com/[^\s\"'<>]+", re.I),
}

# Common junk emails to ignore
_JUNK_EMAIL_DOMAINS: set[str] = {
    "example.com", "sentry.io", "wixpress.com", "googleapis.com",
    "schema.org", "w3.org", "cloudflare.com", "wordpress.org",
    "gravatar.com", "jquery.com",
}


async def scout_website(website_url: str) -> dict[str, Any]:
    """Fully scout a company website for business intelligence.

    Args:
        website_url: Root URL of the company website (e.g. https://acme.com).

    Returns:
        Enriched company profile dict with all extracted intelligence.
    """
    if not website_url:
        return _empty_profile()

    # Normalise URL
    if not website_url.startswith("http"):
        website_url = f"https://{website_url}"
    website_url = website_url.rstrip("/")

    logger.info("Scouting website: %s", website_url)

    profile: dict[str, Any] = _empty_profile()
    profile["website"] = website_url

    fetcher = Fetcher(auto_match=False)
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_SCOUTS)

    async def _fetch_page(path: str) -> Optional[tuple[str, Any]]:
        """Fetch a single page with concurrency control."""
        url = urljoin(website_url + "/", path.lstrip("/"))
        async with semaphore:
            try:
                page = await fetcher.async_fetch(
                    url, stealthy_headers=True, timeout=15
                )
                if page and page.status == 200:
                    return (path, page)
                logger.debug("  %s → HTTP %s", path, page.status if page else "None")
            except Exception as exc:
                logger.debug("  %s → error: %s", path, exc)
            return None

    # Fetch all pages concurrently (bounded)
    tasks = [_fetch_page(p) for p in _SCOUT_PATHS]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    pages: dict[str, Any] = {}
    for res in results:
        if isinstance(res, tuple):
            path, page = res
            pages[path] = page

    if not pages:
        logger.warning("  No pages successfully fetched for %s", website_url)
        return profile

    logger.info("  Fetched %d/%d pages from %s", len(pages), len(_SCOUT_PATHS), website_url)

    # ── Extract data from all pages ────────────────────────────────
    all_text_parts: list[str] = []
    all_html_parts: list[str] = []

    for path, page in pages.items():
        try:
            text = page.get_all_text() if hasattr(page, "get_all_text") else (page.text or "")
            html = str(page.html) if hasattr(page, "html") else ""
            all_text_parts.append(text)
            all_html_parts.append(html)

            # Page-specific extraction
            if path in ("/", "/about", "/about-us"):
                _extract_company_info(page, text, profile)
            if path in ("/contact", "/contact-us"):
                _extract_contact_info(page, text, profile)
            if path in ("/team", "/our-team", "/about", "/about-us"):
                _extract_people(page, text, profile)
            if path in ("/products",):
                _extract_products(page, text, profile)
            if path in ("/careers",):
                _extract_growth_signals(page, text, profile)

        except Exception as exc:
            logger.debug("  Error processing %s: %s", path, exc)

    # Global extraction across all text/html
    combined_text = "\n".join(all_text_parts)
    combined_html = "\n".join(all_html_parts)

    _extract_emails(combined_text, combined_html, profile)
    _extract_phones(combined_text, profile)
    _extract_socials(combined_html, profile)
    _extract_certifications(combined_text, profile)
    _extract_software(combined_text, profile)
    _extract_employee_count(combined_text, profile)
    _extract_revenue(combined_text, profile)

    _dedupe_profile(profile)

    logger.info(
        "  Scout complete for %s — emails: %d, phones: %d, people: %d, certs: %d",
        website_url,
        len(profile["emails"]),
        len(profile["phones"]),
        len(profile["people"]),
        len(profile["certifications"]),
    )

    return profile


# ═══════════════════════════════════════════════════════════════════
# Extraction Functions
# ═══════════════════════════════════════════════════════════════════

def _extract_emails(text: str, html: str, profile: dict) -> None:
    """Extract email addresses from text and HTML."""
    combined = f"{text}\n{html}"
    for match in _EMAIL_RE.findall(combined):
        email = match.lower().strip()
        domain = email.split("@")[-1]
        if domain not in _JUNK_EMAIL_DOMAINS and not email.endswith(".png"):
            profile["emails"].append(email)


def _extract_phones(text: str, profile: dict) -> None:
    """Extract US phone numbers."""
    for match in _US_PHONE_RE.findall(text):
        phone = match.strip()
        # Basic validation: must have 10+ digits
        digits = re.sub(r"\D", "", phone)
        if 10 <= len(digits) <= 11:
            profile["phones"].append(phone)


def _extract_socials(html: str, profile: dict) -> None:
    """Extract social media profile URLs."""
    for platform, pattern in _SOCIAL_PATTERNS.items():
        matches = pattern.findall(html)
        if matches:
            # Take the first clean match
            url = matches[0].rstrip('/"').rstrip("'")
            profile["social_links"][platform] = url


def _extract_company_info(page: Any, text: str, profile: dict) -> None:
    """Extract general company info from homepage / about page."""
    # Try to get the page title
    title_el = page.css_first("title")
    if title_el and not profile.get("page_title"):
        profile["page_title"] = title_el.text.strip()[:150]

    # Meta description
    meta_desc = page.css_first('meta[name="description"]')
    if meta_desc:
        content = meta_desc.attrib.get("content", "")
        if content and not profile.get("description"):
            profile["description"] = content.strip()[:300]


def _extract_contact_info(page: Any, text: str, profile: dict) -> None:
    """Extract contact details from contact pages."""
    # Look for a street address pattern
    addr_match = re.search(
        r"\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)[\s.,]+[\w\s]+,\s*[A-Z]{2}\s+\d{5}",
        text,
    )
    if addr_match:
        profile["address"] = addr_match.group(0).strip()


def _extract_people(page: Any, text: str, profile: dict) -> None:
    """Extract team members / decision makers from team pages."""
    # Common patterns for team member cards
    people_selectors = [
        ".team-member", ".staff-member", ".person", ".team-card",
        "[class*='team']", "[class*='staff']", "[class*='member']",
        ".leadership", "[class*='leader']",
    ]

    for selector in people_selectors:
        cards = page.css(selector)
        if not cards:
            continue

        for card in cards[:20]:
            try:
                # Find name — usually in h3, h4, or strong
                name_el = card.css_first("h3, h4, h5, strong, .name, [class*='name']")
                if not name_el:
                    continue
                name = name_el.text.strip()
                if not name or len(name) < 3 or len(name) > 60:
                    continue

                # Find title/role — usually in a span, p, or class
                title = ""
                title_el = card.css_first(
                    ".title, .role, .position, [class*='title'], [class*='role'], "
                    "[class*='position'], p, span"
                )
                if title_el and title_el != name_el:
                    title = title_el.text.strip()[:80]

                profile["people"].append({
                    "name": name,
                    "title": title,
                })

            except Exception:
                continue

        if profile["people"]:
            break  # Found people, stop trying other selectors

    # Fallback: try to use find_similar if we found at least one person card
    if profile["people"] and len(profile["people"]) < 3:
        try:
            first_card = page.css_first(people_selectors[0])
            if first_card and hasattr(first_card, "find_similar"):
                similar = first_card.find_similar()
                for card in similar[:15]:
                    name_el = card.css_first("h3, h4, h5, strong")
                    if name_el:
                        name = name_el.text.strip()
                        title_el = card.css_first("p, span")
                        title = title_el.text.strip()[:80] if title_el else ""
                        if name and len(name) >= 3:
                            profile["people"].append({"name": name, "title": title})
        except Exception:
            pass


def _extract_products(page: Any, text: str, profile: dict) -> None:
    """Extract product/service information from product pages."""
    product_selectors = [
        ".product", ".product-card", "[class*='product']",
        ".service", "[class*='service']",
    ]

    for selector in product_selectors:
        items = page.css(selector)
        for item in items[:15]:
            try:
                name_el = item.css_first("h2, h3, h4, .name, [class*='name'], a")
                if name_el:
                    name = name_el.text.strip()[:100]
                    if name and len(name) >= 3:
                        profile["products"].append(name)
            except Exception:
                continue


def _extract_growth_signals(page: Any, text: str, profile: dict) -> None:
    """Detect growth signals from careers and other pages."""
    text_lower = text.lower()
    signals: list[str] = []

    if "hiring" in text_lower or "careers" in text_lower:
        # Count job listings
        job_cards = page.css(
            ".job, .position, .opening, [class*='job'], [class*='career']"
        )
        if job_cards:
            signals.append(f"{len(job_cards)} open positions")
        else:
            signals.append("actively hiring")

    if "expanding" in text_lower or "new facility" in text_lower:
        signals.append("expanding operations")
    if "new product" in text_lower or "product launch" in text_lower:
        signals.append("launching new products")

    profile["growth_signals"] = signals


def _extract_certifications(text: str, profile: dict) -> None:
    """Detect food safety and quality certifications."""
    text_upper = text.upper()
    for cert in TARGET_CERTIFICATIONS:
        if cert.upper() in text_upper:
            profile["certifications"].append(cert)


def _extract_software(text: str, profile: dict) -> None:
    """Detect current software/ERP systems in use."""
    text_lower = text.lower()
    for sw in COMPETITOR_SOFTWARE:
        if sw.lower() in text_lower:
            profile["current_software"].append(sw)


def _extract_employee_count(text: str, profile: dict) -> None:
    """Extract employee count mentions."""
    match = _EMPLOYEE_RE.search(text)
    if match:
        count_str = match.group(1).replace(",", "")
        try:
            profile["estimated_employees"] = int(count_str)
        except ValueError:
            pass


def _extract_revenue(text: str, profile: dict) -> None:
    """Extract revenue mentions."""
    match = _REVENUE_RE.search(text)
    if match:
        profile["estimated_revenue"] = match.group(0)


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _empty_profile() -> dict[str, Any]:
    """Return an empty company profile template."""
    return {
        "website": "",
        "page_title": "",
        "description": "",
        "address": "",
        "emails": [],
        "phones": [],
        "people": [],
        "products": [],
        "certifications": [],
        "current_software": [],
        "social_links": {},
        "estimated_employees": None,
        "estimated_revenue": None,
        "growth_signals": [],
    }


def _dedupe_profile(profile: dict) -> None:
    """Remove duplicates from list fields."""
    for key in ("emails", "phones", "products", "certifications", "current_software"):
        if profile.get(key):
            seen: set[str] = set()
            unique: list = []
            for item in profile[key]:
                val = item.lower() if isinstance(item, str) else str(item)
                if val not in seen:
                    seen.add(val)
                    unique.append(item)
            profile[key] = unique

    # Dedupe people by name
    if profile.get("people"):
        seen_names: set[str] = set()
        unique_people: list[dict] = []
        for p in profile["people"]:
            name = p["name"].lower()
            if name not in seen_names:
                seen_names.add(name)
                unique_people.append(p)
        profile["people"] = unique_people
