"""
Celeritech Orbit — Google Search Scraper
=========================================
Uses Scrapling StealthyFetcher to search Google for company websites.
Supplementary source to find businesses not present on Maps.
Extracts URLs from search results and returns RawLead dicts.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import Any
from urllib.parse import quote_plus, urlparse

from scrapling import StealthyFetcher

from scraper.config import (
    GOOGLE_SEARCH_TEMPLATES,
    MAPS_RATE_LIMIT_MAX,
    MAPS_RATE_LIMIT_MIN,
    MAX_PAGES_PER_SOURCE,
    SUBCATEGORY_KEYWORDS,
    TOP_CITIES,
    DEFAULT_CITY,
)

logger = logging.getLogger("orbit.sources.google_search")

# Domains to skip when collecting company URLs
_SKIP_DOMAINS: set[str] = {
    "google.com", "google.co", "gstatic.com", "youtube.com",
    "wikipedia.org", "facebook.com", "twitter.com", "x.com",
    "instagram.com", "linkedin.com", "yelp.com", "bbb.org",
    "yellowpages.com", "manta.com", "thomasnet.com", "indeed.com",
    "glassdoor.com", "zoominfo.com", "dnb.com", "bloomberg.com",
    "mapquest.com", "tripadvisor.com", "pinterest.com",
}


async def scrape_google_search(campaign: dict) -> list[dict[str, Any]]:
    """Search Google for company websites matching campaign criteria.

    Args:
        campaign: Campaign configuration dict.

    Returns:
        List of RawLead dicts with company_name, website, and source.
    """
    queries = _build_queries(campaign)
    if not queries:
        logger.warning("No Google Search queries for campaign %s", campaign.get("id"))
        return []

    max_queries = campaign.get("max_queries", MAX_PAGES_PER_SOURCE * 2)
    queries = queries[:max_queries]
    logger.info("Google Search: %d queries for campaign %s", len(queries), campaign.get("id"))

    fetcher = StealthyFetcher()
    all_results: list[dict[str, Any]] = []
    seen_domains: set[str] = set()

    for i, query in enumerate(queries, 1):
        try:
            logger.info("  [%d/%d] Google: %s", i, len(queries), query[:80])
            url = f"https://www.google.com/search?q={quote_plus(query)}&num=20"

            page = await fetcher.async_fetch(
                url,
                headless=True,
                network_idle=True,
                timeout=25000,
            )

            if not page or page.status != 200:
                logger.warning("  Google Search non-200 for: %s", query[:60])
                await _delay()
                continue

            results = _extract_results(page, query, seen_domains)
            all_results.extend(results)
            logger.info("  Google Search: %d new results for: %s", len(results), query[:60])

        except Exception as exc:
            logger.error("  Google Search error for '%s': %s", query[:60], exc)

        await _delay()

    logger.info("Google Search total: %d raw leads", len(all_results))
    return all_results


def _build_queries(campaign: dict) -> list[str]:
    """Build Google search queries from campaign config."""
    queries: list[str] = []
    keywords: list[str] = list(campaign.get("keywords", []))
    for subcat in campaign.get("subcategories", []):
        keywords.extend(SUBCATEGORY_KEYWORDS.get(subcat, []))
    if not keywords:
        keywords = ["food manufacturer", "beverage manufacturer"]

    states = campaign.get("states", ["CA"])
    custom_cities = campaign.get("cities", [])

    for kw in keywords:
        for state in states:
            cities = custom_cities or TOP_CITIES.get(state, [DEFAULT_CITY])
            for city in cities[:2]:
                for template in GOOGLE_SEARCH_TEMPLATES[:2]:
                    q = template.format(keyword=kw, city=city, state=state)
                    if q not in queries:
                        queries.append(q)

    return queries


def _extract_results(
    page: Any, query: str, seen_domains: set[str]
) -> list[dict[str, Any]]:
    """Extract company websites from Google search results."""
    results: list[dict[str, Any]] = []

    try:
        # Google organic results are in <div class="g"> or similar
        result_blocks = page.css("div.g, div[data-sokoban-container]")
        if not result_blocks:
            # Broader fallback
            result_blocks = page.css("div[class*='result']")

        for block in result_blocks[:20]:
            try:
                # Find the main link
                link = block.css_first("a[href^='http']")
                if not link:
                    continue

                href = link.attrib.get("href", "")
                if not href or not href.startswith("http"):
                    continue

                parsed = urlparse(href)
                domain = parsed.netloc.replace("www.", "").lower()

                # Skip non-company domains
                if any(skip in domain for skip in _SKIP_DOMAINS):
                    continue
                if domain in seen_domains:
                    continue
                seen_domains.add(domain)

                # Extract title
                title_el = block.css_first("h3")
                title = title_el.text.strip() if title_el else domain

                # Extract snippet for additional context
                snippet = ""
                snippet_el = block.css_first(
                    "div[class*='snippet'], span[class*='snippet'], "
                    "div[data-content-feature], .VwiC3b"
                )
                if snippet_el:
                    snippet = snippet_el.text.strip()[:200]

                results.append({
                    "company_name": title,
                    "website": f"{parsed.scheme}://{parsed.netloc}",
                    "address": "",
                    "phone": "",
                    "category": snippet,
                    "source": "google_search",
                    "source_query": query,
                    "rating": None,
                    "review_count": None,
                })

            except Exception as exc:
                logger.debug("  Google result parse error: %s", exc)
                continue

    except Exception as exc:
        logger.error("Google results extraction error: %s", exc)

    return results


async def _delay() -> None:
    """Random delay between Google searches."""
    await asyncio.sleep(random.uniform(MAPS_RATE_LIMIT_MIN, MAPS_RATE_LIMIT_MAX))
