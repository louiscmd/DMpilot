# DM Pilot

Local Instagram DM outreach: import LeadOS leads → Claude writes a personalized DM per lead → send them in **Assisted** or **Automatic** mode.

## Start
Double-click `Start DM Pilot.bat` (first run installs dependencies). The app opens at http://127.0.0.1:4777.

## Flow
1. **Settings**: paste your Claude API key.
2. **Campaign**: describe your offer, tone and an example DM.
3. **Leads**: import a LeadOS `.json` export (or CSV / pasted handles), then click **Write DMs with Claude**. Review and edit messages inline.
4. **Send**: open the Instagram window, log in once, pick a mode, press Start.

- **Assisted**: the app opens each chat and types the DM; you press Enter; it moves to the next lead.
- **Automatic**: sends by itself with random gaps, breaks, a daily cap and active hours. It pauses on any Instagram warning, login/verification screen, or 3 failures in a row. This breaks Instagram's terms, so the account is at risk.

All data (leads, settings, API key, browser login) stays in `data/` on this computer.
