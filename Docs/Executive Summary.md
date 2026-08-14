# Dealer Offer Intelligence Platform - System Overview

## Purpose

Build a platform that collects dealership marketing offers from dealer websites, stores historical evidence, and generates competitive intelligence reports.

The system is not a scraper.

The system is a dealer offer intelligence platform.

Its responsibilities are:

1. Collect offer data from dealership websites.
2. Capture supporting evidence (screenshots and disclaimers).
3. Normalize offer information into structured records.
4. Maintain historical snapshots.
5. Generate competitor comparison reports.

## Technology Stack

Frontend:

* Next.js
* TypeScript

Backend:

* TypeScript
* Node.js
* Chrome extension (collection)

Database:

* Neon Postgres

Storage:

* Cloudflare R2

Deployment:

* The admin app runs locally on the operator's own machine (needs a
  persistent Node process, and collection needs the operator's own Chrome
  plus the extension — nothing to remote into).
* The report viewer is a separate, thin Next.js app deployed on Vercel. It
  only reads published snapshots.

## Core Workflow

Collection Run
→ Review Queue
→ Publish Snapshot
→ Generate Reports

Reports never run directly from collection data.

Reports only run from approved snapshots.

## Design Principles

* Mission-driven collection.
* Deterministic navigation.
* AI used only for classification and interpretation.
* Human review for exceptions.
* Historical evidence retained.
* Sites treated as generic entities.
* Competitor relationships handled separately from collection.

## Primary Entities

Site
Mission
Collection Run
Evidence
Offer
Snapshot
Report

## Initial Missions

* Homepage Offers
* Finance Offers
* Service Specials
* Promotional Banners

Additional missions can be added without modifying the collection engine.
