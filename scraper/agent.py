"""
agent.py — Core Lead Generation Agent

One agent instance per campaign. Runs the full pipeline:
Discover → Scout → Qualify → Store → Outreach

Each agent operates on its own schedule and can be paused/resumed.
"""

import asyncio
import hashlib
import logging
import traceback
from datetime import datetime, timezone
from typing import Any

from . import config
from .outreach import OutreachManager
from .qualify import qualify_lead
from .scout import scout_website
from .sources.directories import scrape_thomasnet, scrape_manta
from .sources.google_maps import scrape_google_maps
from .sources.google_search import scrape_google_search
from .store import RedisStore

logger = logging.getLogger(__name__)


class LeadGenAgent:
    """
    Autonomous lead generation agent for a single campaign.
    
    Runs discovery, scouting, qualification, and outreach in a 
    single cycle. Designed to run on a schedule (e.g., every 6 hours).
    """

    def __init__(self, campaign: dict[str, Any], store: RedisStore):
        self.campaign = campaign
        self.campaign_id = campaign.get("id") or campaign.get("_id")
        self.config = campaign.get("config", campaign)
        self.store = store
        self.status = "running"
        
        # Outreach manager
        self.outreach_manager = OutreachManager(campaign)
        
        # Stats for this cycle
        self._cycle_stats = {
            "discovered": 0,
            "scouted": 0,
            "qualified": 0,
            "new_leads": 0,
            "emails_sent": 0,
            "errors": 0,
        }

    # ── Main Run Cycle ────────────────────────────────────────────

    async def run_cycle(self) -> dict[str, Any]:
        """
        Execute one full scrape-scout-qualify-store-outreach cycle.
        
        Returns cycle stats dict.
        """
        logger.info(f"🚀 Starting cycle for campaign '{self.campaign.get('name', self.campaign_id)}'")
        self._cycle_stats = {
            "discovered": 0, "scouted": 0, "qualified": 0,
            "new_leads": 0, "emails_sent": 0, "errors": 0,
        }
        
        try:
            # Phase 1: Discover companies
            raw_leads = await self._discover()
            self._cycle_stats["discovered"] = len(raw_leads)
            logger.info(f"📍 Discovered {len(raw_leads)} companies")
            
            if self.status != "running":
                logger.info("Agent paused — stopping cycle after discovery")
                return self._cycle_stats
            
            # Phase 2: Deduplicate against existing leads
            existing_leads = await self.store.get_leads(self.campaign_id)
            existing_keys = set()
            for lead in existing_leads:
                key = self._lead_key(lead)
                if key:
                    existing_keys.add(key)
            
            new_raw = []
            for lead in raw_leads:
                key = self._lead_key(lead)
                if key and key not in existing_keys:
                    new_raw.append(lead)
                    existing_keys.add(key)
            
            logger.info(f"🆕 {len(new_raw)} new companies (after dedup)")
            
            if not new_raw:
                logger.info("No new companies to process this cycle")
                # Still run outreach on existing leads
                await self._run_outreach(existing_leads)
                return self._cycle_stats
            
            # Phase 3: Scout each company's website
            scouted_leads = []
            for raw in new_raw:
                if self.status != "running":
                    break
                try:
                    scouted = await self._scout(raw)
                    scouted_leads.append(scouted)
                    self._cycle_stats["scouted"] += 1
                except Exception as e:
                    logger.error(f"Scout error for {raw.get('name', '?')}: {e}")
                    scouted_leads.append(raw)  # Keep raw data
                    self._cycle_stats["errors"] += 1
                
                # Rate limit between scouts
                await asyncio.sleep(2)
            
            logger.info(f"🔍 Scouted {self._cycle_stats['scouted']} companies")
            
            # Phase 4: Qualify with Claude AI
            qualified_leads = []
            for scouted in scouted_leads:
                if self.status != "running":
                    break
                try:
                    qualification = await qualify_lead(scouted, self.campaign)
                    
                    # Build the full lead object
                    lead = self._build_lead(scouted, qualification)
                    qualified_leads.append(lead)
                    self._cycle_stats["qualified"] += 1
                    
                except Exception as e:
                    logger.error(f"Qualify error for {scouted.get('name', '?')}: {e}")
                    self._cycle_stats["errors"] += 1
                
                # Small delay between API calls
                await asyncio.sleep(1)
            
            logger.info(f"🤖 Qualified {self._cycle_stats['qualified']} leads")
            
            # Phase 5: Store new leads
            for lead in qualified_leads:
                try:
                    await self.store.save_lead(lead)
                    self._cycle_stats["new_leads"] += 1
                except Exception as e:
                    logger.error(f"Store error: {e}")
                    self._cycle_stats["errors"] += 1
            
            logger.info(f"💾 Stored {self._cycle_stats['new_leads']} new leads")
            
            # Phase 6: Run outreach on all leads (existing + new)
            all_leads = existing_leads + qualified_leads
            await self._run_outreach(all_leads)
            
            # Update campaign stats
            await self._update_campaign_stats()
            
        except Exception as e:
            logger.error(f"❌ Cycle error: {e}\n{traceback.format_exc()}")
            self._cycle_stats["errors"] += 1
        
        logger.info(
            f"✅ Cycle complete for '{self.campaign.get('name', '')}' — "
            f"Discovered: {self._cycle_stats['discovered']}, "
            f"New: {self._cycle_stats['new_leads']}, "
            f"Errors: {self._cycle_stats['errors']}"
        )
        
        return self._cycle_stats

    # ── Discovery ─────────────────────────────────────────────────

    async def _discover(self) -> list[dict[str, Any]]:
        """Run all discovery sources and merge results."""
        all_leads: list[dict[str, Any]] = []
        
        # Build search queries from config
        config = self.config
        industry = config.get("industry", "food_beverage")
        sub_cats = config.get("subCategories", [])
        keywords = config.get("keywords", [])
        regions = config.get("regions", [])
        cities = config.get("cities", [])
        
        # Build keyword list
        search_terms = []
        if sub_cats:
            search_terms.extend(sub_cats)
        if keywords:
            search_terms.extend(keywords)
        if not search_terms:
            # Default F&B search terms
            search_terms = [
                "food manufacturer", "food processing", "beverage manufacturer",
                "dairy processing", "bakery manufacturer", "meat processing",
            ]
        
        # Build location list
        locations = list(cities)
        if not locations and regions:
            # Use state names as locations
            locations = regions[:5]  # Limit to first 5 states
        if not locations:
            locations = ["United States"]
        
        # Source 1: Google Maps
        try:
            maps_results = await scrape_google_maps(self.campaign)
            all_leads.extend(maps_results)
            logger.info(f"Google Maps found {len(maps_results)} results")
        except Exception as e:
            logger.error(f"Google Maps scraper error: {e}")
        
        # Source 2: Industry directories (ThomasNet + Manta)
        try:
            thomas_results = await scrape_thomasnet(self.campaign)
            all_leads.extend(thomas_results)
            logger.info(f"ThomasNet found {len(thomas_results)} results")
        except Exception as e:
            logger.error(f"ThomasNet scraper error: {e}")
        
        try:
            manta_results = await scrape_manta(self.campaign)
            all_leads.extend(manta_results)
            logger.info(f"Manta found {len(manta_results)} results")
        except Exception as e:
            logger.error(f"Manta scraper error: {e}")
        
        # Source 3: Google Search
        try:
            search_results = await scrape_google_search(self.campaign)
            all_leads.extend(search_results)
            logger.info(f"Google Search found {len(search_results)} results")
        except Exception as e:
            logger.error(f"Google Search scraper error: {e}")
        
        # Deduplicate by name + address/website
        deduped = self._deduplicate(all_leads)
        logger.info(f"Total after dedup: {len(deduped)} (from {len(all_leads)} raw)")
        
        return deduped

    # ── Scouting ──────────────────────────────────────────────────

    async def _scout(self, raw_lead: dict[str, Any]) -> dict[str, Any]:
        """Scout a company's website for detailed information."""
        website = raw_lead.get("website")
        if not website:
            logger.debug(f"No website for {raw_lead.get('name', '?')} — skipping scout")
            return raw_lead
        
        scouting_data = await scout_website(website)
        raw_lead["scouting"] = scouting_data
        
        return raw_lead

    # ── Outreach ──────────────────────────────────────────────────

    async def _run_outreach(self, leads: list[dict[str, Any]]) -> None:
        """Run outreach processing on all leads."""
        try:
            updated = await self.outreach_manager.process_campaign_outreach(leads, self.store)
            # Save updated leads
            for lead in updated:
                try:
                    lead_id = lead.get("id") or lead.get("_id")
                    if lead_id:
                        await self.store.update_lead(lead_id, lead)
                except Exception as e:
                    logger.error(f"Error saving outreach update: {e}")
        except Exception as e:
            logger.error(f"Outreach processing error: {e}")

    # ── Build Lead Object ─────────────────────────────────────────

    def _build_lead(
        self, scouted: dict[str, Any], qualification: dict[str, Any]
    ) -> dict[str, Any]:
        """Build a standardized lead object from scouted data + qualification."""
        import time
        
        lead_id = f"lead_{int(time.time() * 1000)}"
        scouting = scouted.get("scouting", {})
        
        # Extract primary contact
        contacts = []
        dm = qualification.get("decision_makers", [])
        if dm:
            contacts = dm
        elif scouting.get("people"):
            contacts = [
                {
                    "name": p.get("name", ""),
                    "title": p.get("title", ""),
                    "email": p.get("email", ""),
                    "phone": "",
                }
                for p in scouting["people"][:5]
            ]
        
        # Primary contact
        primary_contact = contacts[0] if contacts else {}
        
        # Map scouting emails to contacts if no people found
        if not contacts and scouting.get("emails"):
            for email in scouting["emails"][:3]:
                contacts.append({"name": "", "title": "", "email": email, "phone": ""})
            primary_contact = contacts[0] if contacts else {}
        
        email_draft = qualification.get("personalized_email_draft", {})
        
        return {
            "id": lead_id,
            "campaign_id": self.campaign_id,
            "status": "new",
            "score": qualification.get("score", 0),
            "company": {
                "name": scouted.get("name", "Unknown"),
                "website": scouted.get("website", ""),
                "address": scouted.get("address", ""),
                "city": self._extract_city(scouted.get("address", "")),
                "state": self._extract_state(scouted.get("address", "")),
                "phone": scouted.get("phone", ""),
                "employees": qualification.get("estimated_employees"),
                "revenue": qualification.get("estimated_revenue"),
                "products": ", ".join(scouting.get("products", [])[:5]),
                "certifications": ", ".join(scouting.get("certifications", [])),
                "software": ", ".join(qualification.get("current_software", [])),
                "socialLinks": list(filter(None, [
                    scouting.get("social_links", {}).get("linkedin"),
                    scouting.get("social_links", {}).get("facebook"),
                ])),
            },
            "contact": primary_contact,
            "contacts": contacts,
            "qualification": {
                "score": qualification.get("score", 0),
                "fitLevel": qualification.get("fit_level", "low"),
                "reasoning": qualification.get("reasoning", ""),
                "painPoints": qualification.get("pain_points", []),
            },
            "emailDraft": email_draft,
            "outreach": {
                "emailsSent": 0,
                "lastEmailDate": None,
                "ghlContactId": None,
            },
            "outreachTimeline": [],
            "emailStatus": "not_sent",
            "emailSentAt": None,
            "replyStatus": None,
            "repliedAt": None,
            "nextAction": "email" if qualification.get("score", 0) >= self.outreach_manager.min_score else None,
            "nextActionDate": None,
            "source": scouted.get("source", "unknown"),
            "sourceQuery": scouted.get("source_query", ""),
            "discoveredAt": datetime.now(timezone.utc).isoformat(),
            "lastUpdatedAt": datetime.now(timezone.utc).isoformat(),
        }

    # ── Helpers ────────────────────────────────────────────────────

    def _lead_key(self, lead: dict[str, Any]) -> str | None:
        """Generate a dedup key for a lead."""
        name = (lead.get("name") or lead.get("company", {}).get("name") or "").lower().strip()
        website = (lead.get("website") or lead.get("company", {}).get("website") or "").lower().strip()
        
        if not name and not website:
            return None
        
        raw = f"{name}|{website}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _deduplicate(self, leads: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Remove duplicate leads by name + website."""
        seen: dict[str, dict[str, Any]] = {}
        for lead in leads:
            key = self._lead_key(lead)
            if key is None:
                continue
            if key not in seen:
                seen[key] = lead
            else:
                # Merge — keep the one with more data
                existing = seen[key]
                if len(str(lead)) > len(str(existing)):
                    seen[key] = lead
        return list(seen.values())

    def _extract_city(self, address: str) -> str:
        """Extract city from address string."""
        if not address:
            return ""
        parts = address.split(",")
        if len(parts) >= 2:
            return parts[-2].strip()
        return ""

    def _extract_state(self, address: str) -> str:
        """Extract state from address string."""
        if not address:
            return ""
        parts = address.split(",")
        if len(parts) >= 1:
            last = parts[-1].strip()
            # Try to extract state code (e.g., "FL 33125")
            tokens = last.split()
            if tokens and len(tokens[0]) == 2 and tokens[0].isalpha():
                return tokens[0].upper()
        return ""

    async def _update_campaign_stats(self) -> None:
        """Update campaign aggregate stats in the store."""
        try:
            leads = await self.store.get_leads(self.campaign_id)
            stats = {
                "found": len(leads),
                "qualified": sum(1 for l in leads if (l.get("score") or 0) >= 50),
                "emailed": sum(1 for l in leads if l.get("emailStatus") == "sent"),
                "replied": sum(1 for l in leads if l.get("replyStatus") == "replied"),
                "meetings": sum(1 for l in leads if l.get("status") == "meeting_booked"),
                "disqualified": sum(1 for l in leads if l.get("status") == "disqualified"),
                "lastRunAt": datetime.now(timezone.utc).isoformat(),
            }
            await self.store.save_campaign_stats(self.campaign_id, stats)
        except Exception as e:
            logger.error(f"Error updating campaign stats: {e}")

    # ── Control ────────────────────────────────────────────────────

    def pause(self):
        """Pause the agent."""
        self.status = "paused"
        logger.info(f"⏸ Agent paused: {self.campaign.get('name', self.campaign_id)}")

    def resume(self):
        """Resume the agent."""
        self.status = "running"
        logger.info(f"▶ Agent resumed: {self.campaign.get('name', self.campaign_id)}")

    def stop(self):
        """Stop the agent."""
        self.status = "stopped"
        logger.info(f"⏹ Agent stopped: {self.campaign.get('name', self.campaign_id)}")
