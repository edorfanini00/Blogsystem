"""
outreach.py — Email Outreach Sequence Manager

Manages automated email sequences for qualified leads.
Tracks sent emails, follow-ups, and communicates with the Node.js
server to actually send emails via Nodemailer.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

NODE_SERVER = "http://localhost:3001"


# ── Outreach Sequence ─────────────────────────────────────────────

DEFAULT_SEQUENCE = [
    {"step": 0, "type": "initial", "delay_days": 0, "label": "Initial outreach"},
    {"step": 1, "type": "follow_up_1", "delay_days": 3, "label": "Follow-up #1"},
    {"step": 2, "type": "follow_up_2", "delay_days": 7, "label": "Follow-up #2"},
    {"step": 3, "type": "break_up", "delay_days": 14, "label": "Final follow-up"},
]


class OutreachManager:
    """Manages email outreach sequences for campaign leads."""

    def __init__(self, campaign_config: dict[str, Any]):
        config = campaign_config.get("config", campaign_config)
        outreach = config.get("outreach", {})
        
        self.auto_email = outreach.get("autoEmail", True)
        self.min_score = outreach.get("minScoreEmail", 70)
        self.max_emails = outreach.get("maxEmails", 3)
        self.follow_up_days = outreach.get("followUpDays", 3)
        self.auto_call = outreach.get("autoCall", False)
        self.auto_ghl = outreach.get("autoGHL", False)
        self.min_score_ghl = outreach.get("minScoreGHL", 80)

    async def process_lead(self, lead: dict[str, Any], store) -> dict[str, Any]:
        """
        Process outreach for a single lead. Determines what action to take
        based on the lead's current outreach state.
        
        Returns the updated lead dict.
        """
        if not self.auto_email:
            return lead

        lead_id = lead.get("id") or lead.get("_id")
        score = lead.get("score", 0)
        status = lead.get("status", "new")

        # Skip if disqualified, already replied, or meeting booked
        if status in ("disqualified", "replied", "meeting_booked", "customer"):
            return lead

        # Skip if score too low
        if score < self.min_score:
            return lead

        # Get outreach state
        outreach = lead.get("outreach", {})
        emails_sent = outreach.get("emailsSent", 0)
        last_email_date = outreach.get("lastEmailDate")
        
        # Skip if max emails reached
        if emails_sent >= self.max_emails:
            return lead

        # Determine if it's time to send
        should_send = False
        email_type = "initial"

        if emails_sent == 0:
            # Never emailed — send initial
            should_send = True
            email_type = "initial"
        elif last_email_date:
            # Check if enough time has passed for follow-up
            last_sent = datetime.fromisoformat(last_email_date.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            days_since = (now - last_sent).days
            
            if days_since >= self.follow_up_days:
                should_send = True
                if emails_sent == 1:
                    email_type = "follow_up_1"
                elif emails_sent == 2:
                    email_type = "follow_up_2"
                else:
                    email_type = "break_up"

        if should_send:
            lead = await self._send_email(lead, email_type)

        # Auto-push to GHL if score is high enough
        if self.auto_ghl and score >= self.min_score_ghl:
            ghl_id = outreach.get("ghlContactId")
            if not ghl_id:
                await self._push_to_ghl(lead_id)

        return lead

    async def _send_email(
        self, lead: dict[str, Any], email_type: str
    ) -> dict[str, Any]:
        """Send an email to a lead via the Node.js server."""
        lead_id = lead.get("id") or lead.get("_id")
        
        # Get contact email
        contact = lead.get("contact", {})
        contacts = lead.get("contacts", [])
        to_email = contact.get("email") or (contacts[0].get("email") if contacts else None)
        
        if not to_email:
            logger.warning(f"No email found for lead {lead_id} — skipping")
            return lead

        # Get email draft from qualification
        qualification = lead.get("qualification", {})
        email_draft = qualification.get("personalized_email_draft", {})
        
        subject = email_draft.get("subject", "")
        body = email_draft.get("body", "")
        
        # Modify subject/body for follow-ups
        if email_type == "follow_up_1":
            subject = f"Re: {subject}" if subject else "Following up"
            body = f"Hi, I wanted to follow up on my previous email. {body[:200]}..."
        elif email_type == "follow_up_2":
            subject = f"Re: {subject}" if subject else "Quick check-in"
            body = (
                "I understand you're busy — just wanted to make sure my previous "
                "messages didn't get lost. Would a quick 15-minute call be helpful?"
            )
        elif email_type == "break_up":
            subject = "Last note from me"
            body = (
                "I don't want to keep bothering you, so this will be my last email. "
                "If you're ever interested in exploring how an ERP system could "
                "streamline your operations, feel free to reach out anytime."
            )

        try:
            async with aiohttp.ClientSession() as session:
                payload = {"to": to_email, "subject": subject, "body": body}
                async with session.post(
                    f"{NODE_SERVER}/api/leads/{lead_id}/email",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status == 200:
                        logger.info(f"✅ Email sent to {to_email} ({email_type})")
                        
                        # Update lead outreach state
                        outreach = lead.get("outreach", {})
                        outreach["emailsSent"] = outreach.get("emailsSent", 0) + 1
                        outreach["lastEmailDate"] = datetime.now(timezone.utc).isoformat()
                        
                        # Calculate next action
                        next_date = (
                            datetime.now(timezone.utc) + timedelta(days=self.follow_up_days)
                        ).isoformat()
                        
                        if outreach["emailsSent"] >= self.max_emails:
                            lead["nextAction"] = "done"
                            lead["nextActionDate"] = None
                        else:
                            lead["nextAction"] = "email"
                            lead["nextActionDate"] = next_date
                        
                        lead["outreach"] = outreach
                        lead["status"] = "emailed" if lead.get("status") == "new" else lead["status"]
                        lead["emailStatus"] = "sent"
                        lead["emailSentAt"] = outreach["lastEmailDate"]
                    else:
                        body_text = await resp.text()
                        logger.error(f"Email send failed ({resp.status}): {body_text}")

        except aiohttp.ClientError as e:
            logger.error(f"Cannot reach Node.js server to send email: {e}")
        except Exception as e:
            logger.error(f"Unexpected error sending email: {e}")

        return lead

    async def _push_to_ghl(self, lead_id: str) -> None:
        """Push a lead to GoHighLevel CRM via the Node.js server."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{NODE_SERVER}/api/leads/{lead_id}/push-ghl",
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status == 200:
                        logger.info(f"✅ Lead {lead_id} pushed to GHL")
                    else:
                        logger.warning(f"GHL push failed for {lead_id}: {resp.status}")
        except Exception as e:
            logger.error(f"Error pushing to GHL: {e}")

    async def process_campaign_outreach(
        self, leads: list[dict[str, Any]], store
    ) -> list[dict[str, Any]]:
        """
        Process outreach for all leads in a campaign.
        Returns the list of updated leads.
        """
        updated = []
        for lead in leads:
            try:
                lead = await self.process_lead(lead, store)
                updated.append(lead)
            except Exception as e:
                logger.error(f"Error processing outreach for lead: {e}")
                updated.append(lead)
        
        return updated
