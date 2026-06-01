"""
Celeritech Orbit — Data Persistence (Redis + JSON Fallback)
============================================================
Provides a unified store that tries Redis first (shared with the
Node.js app via ioredis) and falls back to local JSON files so the
service can run even without Redis configured.

Redis key patterns (must match Node.js conventions):
    orbit_campaigns            → JSON array of all campaigns
    orbit_campaign:{id}        → campaign config object
    orbit_campaign:{id}:leads  → JSON array of lead objects
    orbit_campaign:{id}:stats  → aggregate stats object
    orbit_lead:{id}            → individual lead data
"""

from __future__ import annotations

import json
import logging
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import redis.asyncio as aioredis

from scraper.config import REDIS_URL

logger = logging.getLogger("orbit.store")

# JSON file fallback directory (server/ dir next to scraper/)
_SERVER_DIR = Path(__file__).resolve().parent.parent / "server"
_DATA_DIR = _SERVER_DIR / "data"
_CAMPAIGNS_FILE = _DATA_DIR / "campaigns.json"
_LEADS_FILE = _DATA_DIR / "leads.json"


def _ensure_data_dir() -> None:
    """Create the data directory and seed files if they don't exist."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    for fp in (_CAMPAIGNS_FILE, _LEADS_FILE):
        if not fp.exists():
            fp.write_text("[]", encoding="utf-8")


class RedisStore:
    """Async data store with Redis primary and JSON file fallback.

    All public methods are async.  If Redis is unreachable the store
    silently degrades to local JSON files so the service never crashes.
    """

    def __init__(self) -> None:
        self._redis: Optional[aioredis.Redis] = None
        self._redis_available: bool = False
        _ensure_data_dir()

    # ── Connection ─────────────────────────────────────────────────

    async def connect(self) -> bool:
        """Try to connect to Redis.  Returns True on success."""
        if not REDIS_URL:
            logger.info("No REDIS_URL configured — using JSON file fallback")
            return False
        try:
            self._redis = aioredis.from_url(
                REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
                retry_on_timeout=True,
            )
            await self._redis.ping()
            self._redis_available = True
            logger.info("✅ Connected to Redis")
            return True
        except Exception as exc:
            logger.warning("Redis connection failed (%s) — using JSON fallback", exc)
            self._redis_available = False
            self._redis = None
            return False

    async def close(self) -> None:
        """Gracefully close the Redis connection."""
        if self._redis:
            try:
                await self._redis.aclose()
            except Exception:
                pass
            self._redis = None
            self._redis_available = False

    # ── Internal helpers ───────────────────────────────────────────

    def _read_json(self, path: Path) -> list[dict]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def _write_json(self, path: Path, data: list[dict]) -> None:
        path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")

    async def _redis_get(self, key: str) -> Optional[str]:
        """Safe Redis GET — returns None on any error."""
        if not self._redis_available or not self._redis:
            return None
        try:
            return await self._redis.get(key)
        except Exception as exc:
            logger.warning("Redis GET %s failed: %s", key, exc)
            return None

    async def _redis_set(self, key: str, value: str) -> bool:
        """Safe Redis SET — returns False on any error."""
        if not self._redis_available or not self._redis:
            return False
        try:
            await self._redis.set(key, value)
            return True
        except Exception as exc:
            logger.warning("Redis SET %s failed: %s", key, exc)
            return False

    async def _redis_delete(self, key: str) -> bool:
        if not self._redis_available or not self._redis:
            return False
        try:
            await self._redis.delete(key)
            return True
        except Exception as exc:
            logger.warning("Redis DELETE %s failed: %s", key, exc)
            return False

    # ── Campaigns ──────────────────────────────────────────────────

    async def save_campaign(self, campaign: dict) -> None:
        """Persist a campaign config (upsert by id)."""
        cid = campaign["id"]
        payload = json.dumps(campaign, default=str)

        # Store individual campaign
        await self._redis_set(f"orbit_campaign:{cid}", payload)

        # Update campaigns list
        campaigns = await self.get_campaigns()
        campaigns = [c for c in campaigns if c.get("id") != cid]
        campaigns.append(campaign)

        list_payload = json.dumps(campaigns, default=str)
        stored = await self._redis_set("orbit_campaigns", list_payload)

        # JSON fallback
        if not stored:
            self._write_json(_CAMPAIGNS_FILE, campaigns)

        logger.debug("Saved campaign %s", cid)

    async def get_campaigns(self) -> list[dict]:
        """Return all campaigns."""
        raw = await self._redis_get("orbit_campaigns")
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        return self._read_json(_CAMPAIGNS_FILE)

    async def get_campaign(self, campaign_id: str) -> Optional[dict]:
        """Return a single campaign by id."""
        raw = await self._redis_get(f"orbit_campaign:{campaign_id}")
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        # Fallback: scan the list
        for c in await self.get_campaigns():
            if c.get("id") == campaign_id:
                return c
        return None

    async def delete_campaign(self, campaign_id: str) -> None:
        """Remove a campaign and its associated data."""
        await self._redis_delete(f"orbit_campaign:{campaign_id}")
        await self._redis_delete(f"orbit_campaign:{campaign_id}:leads")
        await self._redis_delete(f"orbit_campaign:{campaign_id}:stats")

        campaigns = await self.get_campaigns()
        campaigns = [c for c in campaigns if c.get("id") != campaign_id]
        list_payload = json.dumps(campaigns, default=str)
        stored = await self._redis_set("orbit_campaigns", list_payload)
        if not stored:
            self._write_json(_CAMPAIGNS_FILE, campaigns)

        # Also remove leads from JSON fallback
        all_leads = self._read_json(_LEADS_FILE)
        all_leads = [l for l in all_leads if l.get("campaign_id") != campaign_id]
        self._write_json(_LEADS_FILE, all_leads)

        logger.info("Deleted campaign %s and its data", campaign_id)

    # ── Leads ──────────────────────────────────────────────────────

    async def save_lead(self, lead: dict) -> None:
        """Persist a single lead (upsert by id)."""
        lid = lead["id"]
        cid = lead.get("campaign_id", "unknown")
        lead.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        lead["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Store individual lead
        await self._redis_set(f"orbit_lead:{lid}", json.dumps(lead, default=str))

        # Add to campaign's leads list
        leads = await self.get_leads(cid)
        leads = [l for l in leads if l.get("id") != lid]
        leads.append(lead)

        list_payload = json.dumps(leads, default=str)
        stored = await self._redis_set(f"orbit_campaign:{cid}:leads", list_payload)

        # JSON fallback
        if not stored:
            all_leads = self._read_json(_LEADS_FILE)
            all_leads = [l for l in all_leads if l.get("id") != lid]
            all_leads.append(lead)
            self._write_json(_LEADS_FILE, all_leads)

        logger.debug("Saved lead %s for campaign %s", lid, cid)

    async def get_leads(self, campaign_id: str) -> list[dict]:
        """Return all leads for a campaign."""
        raw = await self._redis_get(f"orbit_campaign:{campaign_id}:leads")
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        all_leads = self._read_json(_LEADS_FILE)
        return [l for l in all_leads if l.get("campaign_id") == campaign_id]

    async def get_lead(self, lead_id: str) -> Optional[dict]:
        """Return a single lead by id."""
        raw = await self._redis_get(f"orbit_lead:{lead_id}")
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        for l in self._read_json(_LEADS_FILE):
            if l.get("id") == lead_id:
                return l
        return None

    async def update_lead(self, lead_id: str, updates: dict) -> Optional[dict]:
        """Merge updates into an existing lead and persist."""
        lead = await self.get_lead(lead_id)
        if not lead:
            logger.warning("update_lead: lead %s not found", lead_id)
            return None
        lead.update(updates)
        await self.save_lead(lead)
        return lead

    # ── Deduplication ──────────────────────────────────────────────

    @staticmethod
    def _lead_fingerprint(lead: dict) -> str:
        """Generate a dedup fingerprint from name + phone/website."""
        name = (lead.get("company_name") or "").strip().lower()
        phone = (lead.get("phone") or "").replace("-", "").replace(" ", "").strip()
        website = (lead.get("website") or "").strip().lower().rstrip("/")
        raw = f"{name}|{phone}|{website}"
        return hashlib.md5(raw.encode()).hexdigest()

    async def deduplicate_lead(self, lead: dict, campaign_id: str) -> bool:
        """Check if lead already exists in campaign.

        Returns True if it's a duplicate (should be skipped).
        """
        fp = self._lead_fingerprint(lead)
        existing = await self.get_leads(campaign_id)
        for ex in existing:
            if self._lead_fingerprint(ex) == fp:
                return True
        return False

    # ── Campaign Stats ─────────────────────────────────────────────

    async def get_campaign_stats(self, campaign_id: str) -> dict:
        """Return aggregate statistics for a campaign."""
        raw = await self._redis_get(f"orbit_campaign:{campaign_id}:stats")
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass

        # Compute from leads
        leads = await self.get_leads(campaign_id)
        stats = {
            "campaign_id": campaign_id,
            "total_leads": len(leads),
            "qualified": sum(1 for l in leads if l.get("qualification", {}).get("fit_level") in ("high", "medium")),
            "high_fit": sum(1 for l in leads if l.get("qualification", {}).get("fit_level") == "high"),
            "medium_fit": sum(1 for l in leads if l.get("qualification", {}).get("fit_level") == "medium"),
            "low_fit": sum(1 for l in leads if l.get("qualification", {}).get("fit_level") == "low"),
            "emails_sent": sum(l.get("outreach", {}).get("emails_sent", 0) for l in leads),
            "avg_score": round(
                sum(l.get("qualification", {}).get("score", 0) for l in leads) / max(len(leads), 1),
                1,
            ),
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }
        return stats

    async def save_campaign_stats(self, campaign_id: str, stats: dict) -> None:
        """Persist campaign stats snapshot."""
        payload = json.dumps(stats, default=str)
        stored = await self._redis_set(f"orbit_campaign:{campaign_id}:stats", payload)
        if not stored:
            logger.debug("Stats for %s saved only in memory (no Redis)", campaign_id)
