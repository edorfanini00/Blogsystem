"""
Celeritech Orbit — Google Maps Scraper
=======================================
Uses Scrapling's StealthyFetcher to search Google Maps for businesses
matching campaign criteria.  Extracts business name, address, phone,
website, rating, review count, and category.

Rate limited with random 5-10 second delays between searches.
All errors are logged and skipped — never crashes.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import Any
from urllib.parse import quote_plus

from scrapling import StealthyFetcher

from scraper.config import (
    MAPS_RATE_LIMIT_MAX,
    MAPS_RATE_LIMIT_MIN,
    MAX_PAGES_PER_SOURCE,
    SEARCH_QUERY_TEMPLATES,
    SUBCATEGORY_KEYWORDS,
    TOP_CITIES,
    DEFAULT_CITY,
)

logger = logging.getLogger("orbit.sources.google_maps")


def _build_queries(campaign: dict) -> list[str]:
    """Build Google Maps search queries from campaign configuration.

    Campaign should contain:
        keywords: list[str]       — e.g. ["dairy manufacturer"]
        subcategories: list[str]  — e.g. ["Dairy", "Bakery"]
        states: list[str]         — e.g. ["CA", "TX"]
        cities: list[str]         — optional override
    """
    queries: list[str] = []

    # Collect keywords from campaign + subcategory defaults
    keywords: list[str] = list(campaign.get("keywords", []))
    for subcat in campaign.get("subcategories", []):
        keywords.extend(SUBCATEGORY_KEYWORDS.get(subcat, []))
    if not keywords:
        keywords = ["food manufacturer", "beverage manufacturer"]

    # Collect locations
    states = campaign.get("states", ["CA"])
    custom_cities = campaign.get("cities", [])

    for kw in keywords:
        for state in states:
            cities = custom_cities or TOP_CITIES.get(state, [DEFAULT_CITY])
            for city in cities[:3]:  # Limit to 3 cities per state
                for template in SEARCH_QUERY_TEMPLATES[:2]:  # Use first 2 templates
                    q = template.format(keyword=kw, city=city, state=state)
                    if q not in queries:
                        queries.append(q)

    return queries


async def scrape_google_maps(campaign: dict) -> list[dict[str, Any]]:
    """Scrape Google Maps for businesses matching campaign criteria.

    Args:
        campaign: Campaign configuration dict.

    Returns:
        List of RawLead dicts with keys: company_name, address, phone,
        website, rating, review_count, category, source.
    """
    queries = _build_queries(campaign)
    if not queries:
        logger.warning("No search queries generated for campaign %s", campaign.get("id"))
        return []

    max_queries = campaign.get("max_queries", MAX_PAGES_PER_SOURCE * 3)
    queries = queries[:max_queries]
    logger.info("Google Maps: %d queries to execute for campaign %s", len(queries), campaign.get("id"))

    all_results: list[dict[str, Any]] = []
    fetcher = StealthyFetcher()

    for i, query in enumerate(queries, 1):
        try:
            logger.info("  [%d/%d] Searching Maps: %s", i, len(queries), query[:80])
            url = f"https://www.google.com/maps/search/{quote_plus(query)}"

            page = await fetcher.async_fetch(
                url,
                headless=True,
                network_idle=True,
                wait_selector='div[role="feed"]',
                timeout=30000,
            )

            if not page or not page.status == 200:
                logger.warning("  Maps returned non-200 for query: %s", query[:60])
                await _rate_delay()
                continue

            # Extract business listings from the feed
            results = _extract_listings(page, query)
            all_results.extend(results)
            logger.info("  Found %d results for: %s", len(results), query[:60])

        except Exception as exc:
            logger.error("  Maps scrape error for '%s': %s", query[:60], exc)

        await _rate_delay()

    logger.info("Google Maps total: %d raw leads for campaign %s", len(all_results), campaign.get("id"))
    return all_results


def _extract_listings(page: Any, query: str) -> list[dict[str, Any]]:
    """Extract business listings from a Google Maps search result page."""
    results: list[dict[str, Any]] = []

    try:
        # Google Maps renders results inside divs with role="feed"
        feed = page.css('div[role="feed"]')
        if not feed:
            # Fallback: try to find listing links
            feed = page

        # Each result is typically an <a> with an href containing /maps/place/
        listing_links = page.css('a[href*="/maps/place/"]')

        seen_names: set[str] = set()

        for link in listing_links[:20]:  # Cap at 20 per query
            try:
                raw_text = link.text.strip() if link.text else ""
                if not raw_text or len(raw_text) < 3:
                    continue

                # The link text often contains: Name · Rating · Category · Address
                parts = [p.strip() for p in raw_text.split("·") if p.strip()]
                if not parts:
                    continue

                name = parts[0].strip()
                if name in seen_names or len(name) < 2:
                    continue
                seen_names.add(name)

                # Parse rating and review count
                rating = None
                review_count = None
                category = ""
                address = ""

                for part in parts[1:]:
                    # Rating: e.g. "4.5(123)"
                    rating_match = re.match(r"([\d.]+)\s*\((\d[\d,]*)\)", part)
                    if rating_match:
                        rating = float(rating_match.group(1))
                        review_count = int(rating_match.group(2).replace(",", ""))
                        continue

                    # Rating: standalone number like "4.5"
                    if re.match(r"^\d\.\d$", part):
                        rating = float(part)
                        continue

                    # Category detection (short labels without digits)
                    if len(part) < 40 and not re.search(r"\d{3,}", part):
                        if not category:
                            category = part
                        continue

                    # Address (contains digits — street number)
                    if re.search(r"\d", part) and len(part) > 10:
                        address = part

                # Extract phone from surrounding text
                parent = link.parent
                phone = ""
                if parent:
                    parent_text = parent.text or ""
                    phone_match = re.search(
                        r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}", parent_text
                    )
                    if phone_match:
                        phone = phone_match.group(0)

                # Extract website from sibling links
                website = ""
                if parent:
                    sibling_links = parent.css("a[href]")
                    for sl in sibling_links:
                        href = sl.attrib.get("href", "")
                        if href and "google" not in href and href.startswith("http"):
                            website = href
                            break

                results.append({
                    "company_name": name,
                    "address": address,
                    "phone": phone,
                    "website": website,
                    "rating": rating,
                    "review_count": review_count,
                    "category": category,
                    "source": "google_maps",
                    "source_query": query,
                })

            except Exception as exc:
                logger.debug("  Error parsing listing: %s", exc)
                continue

    except Exception as exc:
        logger.error("Error extracting listings: %s", exc)

    return results


async def _rate_delay() -> None:
    """Random delay between requests to avoid detection."""
    delay = random.uniform(MAPS_RATE_LIMIT_MIN, MAPS_RATE_LIMIT_MAX)
    logger.debug("  Rate delay: %.1fs", delay)
    await asyncio.sleep(delay)
