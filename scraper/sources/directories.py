"""
Celeritech Orbit — Industry Directory Scrapers
================================================
Scrapes ThomasNet and Manta for food & beverage manufacturers.
Each returns standardised RawLead dicts.  Uses Scrapling Fetcher
with stealthy_headers for regular (non-JS) pages.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import Any
from urllib.parse import quote_plus

from scrapling import Fetcher

from scraper.config import (
    RATE_LIMIT_MAX_SECONDS,
    RATE_LIMIT_MIN_SECONDS,
    MAX_PAGES_PER_SOURCE,
)

logger = logging.getLogger("orbit.sources.directories")


# ═══════════════════════════════════════════════════════════════════
# ThomasNet — https://www.thomasnet.com
# ═══════════════════════════════════════════════════════════════════

async def scrape_thomasnet(campaign: dict) -> list[dict[str, Any]]:
    """Search ThomasNet for manufacturers by campaign keywords.

    Args:
        campaign: Campaign config with ``keywords`` and ``subcategories``.

    Returns:
        List of RawLead dicts.
    """
    keywords: list[str] = _campaign_keywords(campaign)
    if not keywords:
        return []

    logger.info("ThomasNet: searching %d keywords", len(keywords))
    fetcher = Fetcher(auto_match=False)
    all_results: list[dict[str, Any]] = []

    for kw in keywords[:MAX_PAGES_PER_SOURCE]:
        try:
            url = f"https://www.thomasnet.com/nsearch.html?cov=NA&what={quote_plus(kw)}"
            logger.info("  ThomasNet: %s", kw)

            page = await fetcher.async_fetch(url, stealthy_headers=True, timeout=20)

            if not page or page.status != 200:
                logger.warning("  ThomasNet non-200 for '%s'", kw)
                await _delay()
                continue

            results = _parse_thomasnet(page, kw)
            all_results.extend(results)
            logger.info("  ThomasNet: %d results for '%s'", len(results), kw)

        except Exception as exc:
            logger.error("  ThomasNet error for '%s': %s", kw, exc)

        await _delay()

    logger.info("ThomasNet total: %d raw leads", len(all_results))
    return all_results


def _parse_thomasnet(page: Any, keyword: str) -> list[dict[str, Any]]:
    """Parse ThomasNet search results page."""
    results: list[dict[str, Any]] = []

    try:
        # ThomasNet listing cards
        cards = page.css(".supplier-result, .company-card, .result-card, .profile-card")
        if not cards:
            # Fallback: try broader selectors
            cards = page.css("div[class*='result'], div[class*='supplier']")

        for card in cards[:15]:
            try:
                # Company name — usually in an <h2> or heading link
                name_el = card.css_first("h2 a, h3 a, a[class*='name'], .company-name")
                if not name_el:
                    continue
                name = name_el.text.strip()
                if not name or len(name) < 2:
                    continue

                # Website link
                website = ""
                link_el = card.css_first("a[href*='http']:not([href*='thomasnet'])")
                if link_el:
                    website = link_el.attrib.get("href", "")

                # Location
                address = ""
                loc_el = card.css_first(".supplier-location, .location, [class*='location'], [class*='address']")
                if loc_el:
                    address = loc_el.text.strip()

                # Phone
                phone = ""
                phone_el = card.css_first("a[href^='tel:'], .phone, [class*='phone']")
                if phone_el:
                    phone = phone_el.text.strip()
                else:
                    card_text = card.text or ""
                    pm = re.search(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}", card_text)
                    if pm:
                        phone = pm.group(0)

                # Category / description
                desc_el = card.css_first(".supplier-description, .description, p")
                category = desc_el.text.strip()[:100] if desc_el else ""

                results.append({
                    "company_name": name,
                    "address": address,
                    "phone": phone,
                    "website": website,
                    "category": category,
                    "source": "thomasnet",
                    "source_query": keyword,
                    "rating": None,
                    "review_count": None,
                })

            except Exception as exc:
                logger.debug("  ThomasNet card parse error: %s", exc)
                continue

    except Exception as exc:
        logger.error("ThomasNet page parse error: %s", exc)

    return results


# ═══════════════════════════════════════════════════════════════════
# Manta — https://www.manta.com
# ═══════════════════════════════════════════════════════════════════

async def scrape_manta(campaign: dict) -> list[dict[str, Any]]:
    """Search Manta for businesses matching campaign keywords.

    Args:
        campaign: Campaign config with ``keywords`` and ``subcategories``.

    Returns:
        List of RawLead dicts.
    """
    keywords: list[str] = _campaign_keywords(campaign)
    if not keywords:
        return []

    logger.info("Manta: searching %d keywords", len(keywords))
    fetcher = Fetcher(auto_match=False)
    all_results: list[dict[str, Any]] = []

    states = campaign.get("states", ["CA"])

    for kw in keywords[:MAX_PAGES_PER_SOURCE]:
        for state in states[:3]:
            try:
                search_term = quote_plus(f"{kw}")
                url = f"https://www.manta.com/search?search={search_term}&search_location={state}"
                logger.info("  Manta: '%s' in %s", kw, state)

                page = await fetcher.async_fetch(url, stealthy_headers=True, timeout=20)

                if not page or page.status != 200:
                    logger.warning("  Manta non-200 for '%s' in %s", kw, state)
                    await _delay()
                    continue

                results = _parse_manta(page, kw)
                all_results.extend(results)
                logger.info("  Manta: %d results for '%s' in %s", len(results), kw, state)

            except Exception as exc:
                logger.error("  Manta error for '%s' in %s: %s", kw, state, exc)

            await _delay()

    logger.info("Manta total: %d raw leads", len(all_results))
    return all_results


def _parse_manta(page: Any, keyword: str) -> list[dict[str, Any]]:
    """Parse Manta search results page."""
    results: list[dict[str, Any]] = []

    try:
        cards = page.css(".search-result, .listing-card, [class*='result-item'], [class*='listing']")
        if not cards:
            cards = page.css("div[class*='result'], li[class*='result']")

        for card in cards[:15]:
            try:
                name_el = card.css_first("h2 a, h3 a, a[class*='title'], .business-name a")
                if not name_el:
                    continue
                name = name_el.text.strip()
                if not name or len(name) < 2:
                    continue

                website = ""
                href = name_el.attrib.get("href", "")
                if href and "manta.com" not in href:
                    website = href

                address = ""
                addr_el = card.css_first(".address, [class*='address'], [class*='location']")
                if addr_el:
                    address = addr_el.text.strip()

                phone = ""
                phone_el = card.css_first("a[href^='tel:'], .phone, [class*='phone']")
                if phone_el:
                    phone = phone_el.text.strip()
                else:
                    card_text = card.text or ""
                    pm = re.search(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}", card_text)
                    if pm:
                        phone = pm.group(0)

                category = ""
                cat_el = card.css_first(".category, [class*='category'], [class*='industry']")
                if cat_el:
                    category = cat_el.text.strip()

                results.append({
                    "company_name": name,
                    "address": address,
                    "phone": phone,
                    "website": website,
                    "category": category,
                    "source": "manta",
                    "source_query": keyword,
                    "rating": None,
                    "review_count": None,
                })

            except Exception as exc:
                logger.debug("  Manta card parse error: %s", exc)
                continue

    except Exception as exc:
        logger.error("Manta page parse error: %s", exc)

    return results


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _campaign_keywords(campaign: dict) -> list[str]:
    """Collect all search keywords from a campaign config."""
    from scraper.config import SUBCATEGORY_KEYWORDS

    kws: list[str] = list(campaign.get("keywords", []))
    for subcat in campaign.get("subcategories", []):
        kws.extend(SUBCATEGORY_KEYWORDS.get(subcat, []))
    if not kws:
        kws = ["food manufacturer", "beverage manufacturer"]
    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for k in kws:
        kl = k.lower()
        if kl not in seen:
            seen.add(kl)
            unique.append(k)
    return unique


async def _delay() -> None:
    """Random delay between requests."""
    await asyncio.sleep(random.uniform(RATE_LIMIT_MIN_SECONDS, RATE_LIMIT_MAX_SECONDS))
