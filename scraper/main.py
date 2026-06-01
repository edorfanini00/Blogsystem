"""
main.py — FastAPI Scraping Service Entry Point

Manages multiple LeadGenAgent instances, one per campaign.
Runs alongside the Node.js Orbit server.

Usage:
    python -m scraper.main
    # or: uvicorn scraper.main:app --port 3002

Runs on port 3002.
"""

import asyncio
import logging
import signal
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .agent import LeadGenAgent
from .store import RedisStore

# ── Logging ───────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("scraper")


# ── Agent Manager ─────────────────────────────────────────────────

class AgentManager:
    """Manages all running LeadGenAgent instances."""

    def __init__(self):
        self.agents: dict[str, LeadGenAgent] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.schedules: dict[str, int] = {}  # campaign_id -> hours
        self.store = RedisStore()
        self._lock = asyncio.Lock()

    async def deploy(self, campaign: dict[str, Any]) -> dict[str, str]:
        """Deploy a new agent for a campaign."""
        campaign_id = campaign.get("id") or campaign.get("_id")
        if not campaign_id:
            raise ValueError("Campaign must have an 'id' field")

        async with self._lock:
            # Stop existing agent if running
            if campaign_id in self.agents:
                await self._stop_agent(campaign_id)

            agent = LeadGenAgent(campaign, self.store)
            self.agents[campaign_id] = agent
            
            # Get schedule hours
            config = campaign.get("config", campaign)
            schedule_hours = config.get("schedule", 6)
            self.schedules[campaign_id] = schedule_hours

            # Start the agent loop
            task = asyncio.create_task(self._agent_loop(campaign_id))
            self.tasks[campaign_id] = task

            logger.info(f"🚀 Deployed agent for campaign {campaign_id} (every {schedule_hours}h)")
            return {"status": "deployed", "campaign_id": campaign_id}

    async def pause(self, campaign_id: str) -> dict[str, str]:
        """Pause a running agent."""
        agent = self.agents.get(campaign_id)
        if not agent:
            raise KeyError(f"No agent found for campaign {campaign_id}")
        
        agent.pause()
        return {"status": "paused", "campaign_id": campaign_id}

    async def resume(self, campaign_id: str) -> dict[str, str]:
        """Resume a paused agent."""
        agent = self.agents.get(campaign_id)
        if not agent:
            raise KeyError(f"No agent found for campaign {campaign_id}")
        
        agent.resume()
        
        # If the task finished, restart the loop
        task = self.tasks.get(campaign_id)
        if task is None or task.done():
            task = asyncio.create_task(self._agent_loop(campaign_id))
            self.tasks[campaign_id] = task
        
        return {"status": "running", "campaign_id": campaign_id}

    async def stop(self, campaign_id: str) -> dict[str, str]:
        """Stop and remove an agent."""
        async with self._lock:
            await self._stop_agent(campaign_id)
        return {"status": "stopped", "campaign_id": campaign_id}

    async def run_now(self, campaign_id: str) -> dict[str, str]:
        """Trigger an immediate run cycle."""
        agent = self.agents.get(campaign_id)
        if not agent:
            raise KeyError(f"No agent found for campaign {campaign_id}")
        
        # Run a cycle in a separate task
        asyncio.create_task(self._run_single_cycle(campaign_id))
        return {"status": "running_now", "campaign_id": campaign_id}

    def list_agents(self) -> list[dict[str, Any]]:
        """List all agents and their status."""
        result = []
        for cid, agent in self.agents.items():
            task = self.tasks.get(cid)
            result.append({
                "campaign_id": cid,
                "campaign_name": agent.campaign.get("name", ""),
                "status": agent.status,
                "schedule_hours": self.schedules.get(cid, 6),
                "task_running": task is not None and not task.done() if task else False,
            })
        return result

    # ── Internal ──────────────────────────────────────────────────

    async def _agent_loop(self, campaign_id: str):
        """Main loop for an agent — runs cycles on schedule."""
        agent = self.agents.get(campaign_id)
        if not agent:
            return

        while agent.status in ("running", "paused"):
            if agent.status == "running":
                try:
                    await agent.run_cycle()
                except Exception as e:
                    logger.error(f"Agent cycle error for {campaign_id}: {e}")

            # Wait for next cycle
            schedule_hours = self.schedules.get(campaign_id, 6)
            wait_seconds = schedule_hours * 3600
            
            logger.info(f"⏰ Next cycle for {campaign_id} in {schedule_hours}h")
            
            # Sleep in chunks so we can respond to pause/stop
            for _ in range(wait_seconds // 10):
                if agent.status == "stopped":
                    return
                await asyncio.sleep(10)
            
            # Check again before running
            if agent.status == "stopped":
                return

    async def _run_single_cycle(self, campaign_id: str):
        """Run a single cycle immediately."""
        agent = self.agents.get(campaign_id)
        if not agent:
            return
        
        prev_status = agent.status
        agent.status = "running"
        try:
            await agent.run_cycle()
        except Exception as e:
            logger.error(f"Run-now cycle error for {campaign_id}: {e}")
        finally:
            if prev_status == "paused":
                agent.status = "paused"

    async def _stop_agent(self, campaign_id: str):
        """Stop an agent and cancel its task."""
        agent = self.agents.get(campaign_id)
        if agent:
            agent.stop()
        
        task = self.tasks.get(campaign_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        
        self.agents.pop(campaign_id, None)
        self.tasks.pop(campaign_id, None)
        self.schedules.pop(campaign_id, None)

    async def shutdown(self):
        """Gracefully stop all agents."""
        logger.info("Shutting down all agents...")
        for cid in list(self.agents.keys()):
            await self._stop_agent(cid)
        logger.info("All agents stopped.")


# ── FastAPI App ───────────────────────────────────────────────────

manager = AgentManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("🔧 Scraping service starting...")
    
    # On startup, check for campaigns that should auto-resume
    try:
        campaigns = await manager.store.get_campaigns()
        running = [c for c in campaigns if c.get("status") == "running"]
        for campaign in running:
            try:
                await manager.deploy(campaign)
                logger.info(f"Auto-resumed campaign: {campaign.get('name', campaign.get('id'))}")
            except Exception as e:
                logger.error(f"Failed to auto-resume campaign: {e}")
    except Exception as e:
        logger.warning(f"Could not check for auto-resume campaigns: {e}")
    
    logger.info("✅ Scraping service ready on port 3002")
    yield
    
    # Shutdown
    await manager.shutdown()
    logger.info("👋 Scraping service stopped")


app = FastAPI(
    title="Celeritech Orbit — Scraping Service",
    description="Lead generation scraping agents manager",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request Models ────────────────────────────────────────────────

class DeployRequest(BaseModel):
    """Campaign data to deploy an agent."""
    id: str | None = None
    _id: str | None = None
    name: str = ""
    config: dict[str, Any] = {}
    status: str = "running"
    stats: dict[str, Any] = {}
    
    model_config = {"extra": "allow"}


# ── Endpoints ─────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "celeritech-orbit-scraper",
        "agents_running": len(manager.agents),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/agents")
async def list_agents():
    """List all running agents and their status."""
    return manager.list_agents()


@app.post("/agents/deploy")
async def deploy_agent(campaign: DeployRequest):
    """Deploy a new agent for a campaign."""
    try:
        data = campaign.model_dump()
        # Handle _id vs id
        if not data.get("id") and data.get("_id"):
            data["id"] = data["_id"]
        
        result = await manager.deploy(data)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Deploy error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/agents/{campaign_id}/pause")
async def pause_agent(campaign_id: str):
    """Pause a running agent."""
    try:
        result = await manager.pause(campaign_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/agents/{campaign_id}/resume")
async def resume_agent(campaign_id: str):
    """Resume a paused agent."""
    try:
        result = await manager.resume(campaign_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/agents/{campaign_id}")
async def stop_agent(campaign_id: str):
    """Stop and remove an agent."""
    try:
        result = await manager.stop(campaign_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/agents/{campaign_id}/run-now")
async def run_now(campaign_id: str):
    """Trigger an immediate run cycle for an agent."""
    try:
        result = await manager.run_now(campaign_id)
        return result
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Main Entry Point ─────────────────────────────────────────────

def main():
    """Run the FastAPI server."""
    import uvicorn
    
    port = 3002
    logger.info(f"Starting scraping service on port {port}...")
    
    uvicorn.run(
        "scraper.main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
