# STANDING ORDERS
# Reference this file for rules that must always be followed.
# Last Updated: 2026-02-11

================================================================================
QUICK INDEX - WHAT'S IN THIS FILE
================================================================================

When told to "refer to standing orders", CHECK THIS INDEX FIRST:

  → Development Rules ............ Line ~25  (coding practices, domain separation)
  → Technology Stacks ............ Line ~60  (languages, frameworks per project)
  → Repository Locations ......... Line ~75  (local paths, GitHub URLs)
  → Docker Build Commands ........ Line ~100 (compose files, build/deploy commands)
  → Quick Reference Commands ..... Line ~125 (copy-paste ready commands)
  → Project Distribution Rules ... Line ~145 (what NOT to include in repos)
  → Verification Guidelines ...... Line ~165 (how to test changes)

CRITICAL REMINDERS:
  • NachoReads source code: /home/nachos/repos/nachoreads
  • Build from: /home/nachos/arr-stack (NOT from nachoreads directory!)
  • ALWAYS use all 3 compose files: docker-compose.yml + addons-compose.yml + docker-compose.override.yml
  • Use --no-cache for dependency/Dockerfile changes, cached OK for code-only changes

================================================================================
NACHOREADS & NACHOGRABS DEVELOPMENT RULES
================================================================================

1. ALWAYS consider the whole picture when adding, modifying, or changing features.
   - Consider each aspect of the functionality before implementing.
   - Ensure code is implemented appropriately across all affected areas.
   - Avoid tunnel vision on a single component.

2. Ebooks and Audiobooks are SEPARATE domains:
   - Search functions are separate for Ebooks and Audiobooks.
   - Browsing functions are separate for Ebooks and Audiobooks.
   - Library functions are separate for Ebooks and Audiobooks.
   - Changes to one domain should not break the other.

3. MAINTAIN per-user functionality throughout the project:
   - User libraries are isolated (per-user folders).
   - Requests are tracked per user.
   - Settings/preferences are per user where applicable.

4. AVOID looping small fixes:
   - Consider the whole picture (rule 1) before implementing fixes.
   - Consider domain separation (rule 2) to prevent cross-contamination.
   - Consider per-user architecture (rule 3) when making changes.
   - If a fix seems to cause another issue, step back and reassess.
   - NOTE: This doesn't mean avoid quick fixes - it means don't fix symptom A,
     then symptom B, then C if they share a root cause. Fix the root cause.

5. Reference ALL standing orders during development:
   - Docker compose rules apply when building/deploying.
   - Project distribution rules apply when committing code.
   - These development rules apply when writing code.

================================================================================
TECHNOLOGY STACKS
================================================================================

  • NachoReads:  React + TypeScript (frontend)
                 Express + Prisma + SQLite (backend)
                 Containerized via Docker
                 
  • NachoGrabs:  Python (scraper/automation)
                 Containerized via Docker
                 
  • NachoSeries: TypeScript + Node.js + SQLite (standalone service)
                 Provides series data to NachoReads via API
                 Database at ./data/nachoseries.db (relative to repo)
                 Runs directly or as a service (NOT containerized)
                 
  • Primarr:     Python (media server integration)
                 Containerized via Docker
                 
  • arr-dashboard: (TBD)

================================================================================
ARR-STACK STRUCTURE & REPOSITORIES
================================================================================

The Arr-Stack I use was created by TheDudeV2.
I am setup as a collaborator for his repo.
⚠️  NEVER push or sync anything to TheDudeV2's repo! Only submit PRs!

UPSTREAM (TheDudeV2 - DO NOT PUSH):
  https://github.com/TheDudeV2/arr-stack

MY REPOSITORIES:
┌─────────────────────────────────────────────────────────────────────────────┐
│ Project       │ Local Path                      │ GitHub URL                │
├─────────────────────────────────────────────────────────────────────────────┤
│ arr-stack     │ /home/nachos/arr-stack          │ github.com/NachosNcheeze/arr-stack     │
│ (fork)        │                                 │                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ NachoReads    │ /home/nachos/repos/nachoreads   │ github.com/NachosNcheeze/NachoReads    │
│ (+ NachoGrabs)│                                 │                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ NachoSeries   │ /home/nachos/repos/nachoseries  │ github.com/NachosNcheeze/nachoseries   │
├─────────────────────────────────────────────────────────────────────────────┤
│ arr-dashboard │ /home/nachos/repos/arr-dashboard│ github.com/NachosNcheeze/arr-dashboard │
├─────────────────────────────────────────────────────────────────────────────┤
│ Primarr       │ /home/nachos/repos/primarr      │ github.com/NachosNcheeze/primarr       │
└─────────────────────────────────────────────────────────────────────────────┘

================================================================================
DOCKER COMPOSE RULES
================================================================================

1. NEVER edit docker-compose.yml without explicit permission.
   - Reason: User receives updates from the arr-stack author.
   - Editing this file will break the stack when updates are applied.

2. All compose file changes go in: /home/nachos/arr-stack/addons-compose.yml

3. Every container in addons-compose.yml must depend on Gluetun being healthy:
   depends_on:
     gluetun:
       condition: service_healthy

4. When starting the arr-stack or any of its containers, always use ALL THREE files:
   docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml <command>

5. When building containers:
   - Use --no-cache for: New dependencies, Dockerfile changes, or "it should work but doesn't"
   - Cached builds OK for: Code-only changes, quick iterations, minor fixes

6. When recreating containers: ALWAYS use --force-recreate unless there's a specific reason not to.
   docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml up -d --force-recreate <service>

================================================================================
QUICK REFERENCE COMMANDS
================================================================================

# Build (no cache - use for dependency/Dockerfile changes):
cd /home/nachos/arr-stack && docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml build --no-cache <service>

# Build (cached - use for code-only changes):
cd /home/nachos/arr-stack && docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml build <service>

# Start/Recreate (force):
cd /home/nachos/arr-stack && docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml up -d --force-recreate <service>

# Stop:
cd /home/nachos/arr-stack && docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml stop <service>

# Logs:
cd /home/nachos/arr-stack && docker compose -f docker-compose.yml -f addons-compose.yml -f docker-compose.override.yml logs -f <service>

================================================================================
PROJECT DISTRIBUTION RULES
================================================================================

7. NEVER include addons-compose.yml files in project repositories (NachoReads, NachoGrabs, Primarr, etc.)
   - Reason: Users have their own addons-compose.yml with custom services.
   - Including one would overwrite their existing configuration.
   - Instead: Document compose configuration in the project's README.md
   - Users manually copy the relevant service definitions to their addons-compose.yml

================================================================================
DATA INTEGRITY & AUTOMATED PROCESSES
================================================================================

8. NEVER manually correct data issues via raw SQL during testing or development.
   - If data is wrong → fix the script or process that produced it, then re-run.
   - If data is missing → fix the gathering or enrichment pipeline.
   - Manual SQL is acceptable ONLY for one-time schema migrations.
   - Why: Manual fixes mask pipeline bugs. The pipeline must be self-correcting.

9. Services (NachoSeries, NachoGrabs, etc.) must manage themselves through
   automated processes:
   - Discovery: Find new data automatically (crawlers, scrapers, imports)
   - Enrichment: Fill missing metadata automatically (descriptions, ISBNs)
   - Correction: Detect and fix data quality issues automatically
   - Maintenance: Dedup, reconcile, and clean up on schedule

10. Fix ROOT CAUSES, not symptoms:
    - When a bug causes multiple symptoms, don't fix A, then B, then C.
    - Step back, identify the root cause, fix it once, verify all symptoms gone.
    - Applies equally to code bugs AND data pipeline bugs.

================================================================================
CONFIG & DATA FILE LOCATIONS
================================================================================

Container config/data files are NOT in the repo folders. They are in:

  • Arr-Stack configs: /home/nachos/arr-stack/
  • MediaStack configs: /home/mediastack/config/
  
Examples:
  • NachoReads database: /home/mediastack/config/nachoreads/nachoreads.db
  • NachoGrabs config:   /home/mediastack/config/nachograbs/config.json
  • Prowlarr config:     /home/mediastack/config/prowlarr/
  • Deluge config:       /home/mediastack/config/deluge/

When looking for runtime data (databases, configs, logs), check these paths first,
NOT the source code repositories.

================================================================================
VERIFICATION GUIDELINES
================================================================================

After making changes, verify they work:

BACKEND CHANGES:
  • Check container logs: docker compose ... logs -f <service>
  • Look for startup errors, runtime exceptions
  • Test affected API endpoints with curl or browser

FRONTEND CHANGES:
  • Test in browser (hard refresh: Ctrl+Shift+R)
  • Check browser console for JavaScript errors
  • Verify UI renders correctly across different views

DATABASE CHANGES:
  • Verify with sqlite3: sqlite3 <path/to/db> "SELECT ..."
  • Check that migrations applied successfully
  • Ensure existing data wasn't corrupted

DOCKER/COMPOSE CHANGES:
  • Verify container starts: docker ps | grep <service>
  • Check health status if applicable
  • Review logs for any warnings

================================================================================
