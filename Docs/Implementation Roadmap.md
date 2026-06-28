# Dealer Offer Intelligence Platform

# Implementation Roadmap

## Guiding Principles

This system is a dealer offer intelligence platform.

It is not a website scraper.

The platform operates as a three-phase pipeline:

1. **Collect** — visit dealer sites, capture all promotional content, store raw evidence in R2.
2. **Analyze** — run passes over stored evidence to classify, normalize, and check ads.
3. **Report** — query analyzed data and render reports. No live site access at this stage.

Collection is the foundation. A missed or partial collection cannot be compensated downstream.
Analysis passes are independent and re-runnable. An ad can be consumed by multiple passes
(specials comparison, compliance check) without re-collecting. Report generation reads from
published analysis snapshots only — deterministic, fast, no site visits.

---

# Phase 1 - Platform Foundation

## Goal

Create the deployable application foundation.

## Deliverables

Infrastructure:

* Next.js
* TypeScript
* Neon Postgres
* Cloudflare R2
* Authentication
* Environment management

Administration UI:

* Site Management
* Mission Management

## Success Criteria

Operator can:

* Create Sites
* Edit Sites
* Disable Sites
* Create Missions
* Edit Missions

No collection functionality exists yet.

---

# Phase 2 - Core Data Model

## Goal

Implement all foundational entities.

## Entities

### Sites

Represents dealer and competitor websites.

### Site Relationships

Represents reporting relationships.

Examples:

* Competitor
* Group Member
* Comparison Set

Collection does not use these relationships.

Reporting does.

### Missions

Defines collection targeting: where to look on a site and how to explore those pages.
A mission is not a business goal — it is a collection configuration.
Business goals (specials report, compliance audit) are expressed at the analysis and reporting layers.

### Collection Runs

Represents a complete collection attempt across a scoped set of sites.

### Evidence

Represents screenshots, disclaimers, and HTML captures. Raw. Uninterpreted.
Evidence is the canonical record — analysis reads from it, never re-collects.

### Offers

Represents normalized offer records produced by the analysis phase.

### Report Snapshots

Represents approved analysis datasets used as reporting inputs.

## Success Criteria

Database schema exists and CRUD operations are functional.

---

# Phase 3 - Run Management

## Goal

Create collection orchestration.

## Deliverables

Run Creation

Run Tracking

Run History

Run Details

## Statuses

Pending

Running

Review

Published

Failed

## Success Criteria

Operator can create and monitor collection runs.

---

# Phase 4 - Evidence Infrastructure

## Goal

Create evidence storage before collection logic.

## Deliverables

Cloudflare R2 Integration

Evidence Upload Service

Evidence Retrieval Service

Evidence Viewer

Supported Evidence Types:

* Screenshot
* HTML Snapshot
* Failure Screenshot
* Disclaimer Screenshot

## Success Criteria

Evidence can be uploaded, retrieved, and associated with collection runs.
R2 URLs are permanent and linkable from reports.

---

# Phase 5 - Collector Engine

## Goal

Create the generic collection engine.

## Collector Responsibilities

Load Pages

Dismiss Cookie Banners

Dismiss Modals

Dismiss Chat Widgets

Scroll Pages

Capture Screenshots

Capture HTML

Store Evidence

## Collector Does Not

Classify or interpret content

Generate reports

Normalize data

Use AI

## Success Criteria

Collector can visit sites and collect evidence.

---

# Phase 6 - Mission Framework

## Goal

Make collection mission-driven.

## Mission Responsibilities

Define likely URLs

Define discovery rules

Define exploration behavior

Examples:

* Explore Carousels
* Explore Tabs
* Expand Accordions

## Success Criteria

Collector executes missions rather than generic site crawling.

---

# Phase 7 - Review Workflow

## Goal

Support human intervention as a normal workflow.

## Deliverables

Review Queue

Failure Dashboard

Evidence Viewer

Retry Mission

Update Mission URL

Mark Content As Removed

## Status Types

Success

Needs Review

Failure

Not Found

## Success Criteria

Operator can resolve collection issues without code changes.

---

# Phase 8 - Collection Consolidation & Site Learning

## Goal

Make collection reliable, comprehensive, and efficient.
Each site is visited once per run; all configured pages are collected in a single session.
A site collected within the past week is considered current.

## Collection Scope

Collection is initiated by run group: a primary dealer plus its competitor set.
Analysis is only available for sites that have a current collection.
Failed sites are tracked separately and do not block the rest of the group.

## Collection Order (per page target)

1. Last Successful URL
2. Site-Specific Alternatives
3. Platform Defaults
4. Mission Discovery Rules
5. AI Fallback (Phase 12)

## Stored Knowledge

Last Successful URL

Mission Success Rate

Platform Type

Known Mission Locations

Last Successful Collection

## Success Criteria

Each site is visited once per run; all content types collected in a single browser session.
Operator can see which sites have fresh vs stale collections.
Collector improves over time without code changes.

---

# Phase 9 - Evidence Analysis

## Goal

Extract structured meaning from collected evidence. No site visits at this stage.

## Analysis Passes

Analysis passes are independent. A piece of evidence can be consumed by multiple passes
without re-collection. New pass types can be added and run retroactively over existing evidence.

### Classification

Determine what kind of ad each piece of evidence represents.

Outputs:
- Ad type (lease, finance, cash, service, promotional)
- Vehicle context (make, model, trim where present)
- Key terms (payment, APR, term, due at signing)
- Confidence score

### Normalization

Convert classified ads into structured offer records suitable for reporting.

Output Fields:

Offer Type

Vehicle

Monthly Payment

APR

Cash Incentive

Term

Due At Signing

Disclaimer

Raw Content

Confidence Score

### Compliance Check

Send evidence + disclaimer text + ad type to external compliance API.
Store the returned grade against the evidence record.
Compliance logic lives entirely in the external service — this platform sends and receives only.

## Inputs

Screenshots

HTML Snapshots

Disclaimer Screenshots

## Success Criteria

Collected evidence becomes structured, queryable offer records.
Compliance grades are attached to evidence records.
An ad can carry results from multiple analysis passes simultaneously.

---

# Phase 10 - Snapshot Publishing

## Goal

Separate analysis from reporting.

## Workflow

Collection Run

↓

Review

↓

Approval

↓

Snapshot Creation

↓

Reporting

## Rules

Reports never use live collection data.

Reports always use published snapshots.

## Success Criteria

Approved snapshots become reporting inputs.

---

# Phase 11 - Reporting Engine

## Goal

Generate competitive intelligence reports.

## Inputs

Published Snapshots

Site Relationships

Historical Data

## Outputs

Dealer Reports

Competitor Reports

Historical Comparisons

Trend Reports

Exports

## Rules

Reporting is pure data retrieval and formatting.
No computation, no AI, no site access.
All thinking happened in the analysis phase.

## Success Criteria

Reports can be generated without rerunning collection or analysis.
Reports link directly to R2-stored evidence images.

---

# Phase 12 - AI-Assisted Analysis

## Goal

Improve analysis quality for difficult cases.

## Appropriate AI Tasks

Offer Classification (low-confidence cases)

Visual Offer Detection

Disclaimer Extraction

Offer Normalization Assistance

## Avoid AI For

Routine Navigation

Routine Collection

Known Mission Paths

Basic Exploration

Report Generation

## Success Criteria

AI improves analysis quality while remaining a secondary system.
Rule-based analysis handles the routine cases; AI handles edge cases.

---

# Reusable Exploration Components

These should be implemented as shared platform components.

## Carousel Explorer

Advance through promotional carousels.

Capture each slide.

## Accordion Explorer

Expand collapsible content.

Capture contents.

## Tab Explorer

Open tabbed content sections.

Capture contents.

## Modal Explorer

Handle promotional popups and overlays.

## Page Scroller

Perform controlled page exploration.

## Cookie Handler

Dismiss cookie consent interfaces.

## Chat Suppression

Dismiss chat widgets and overlays.

---

# Weekly Operational Workflow

Run Weekly News (autos.media news service — must be fresh before reports)

↓

Scheduled Run (group-scoped)

↓

Collection (single visit per site)

↓

Review Queue (fix failed sites, retry misses)

↓

Analysis Passes (classification, normalization, compliance)

↓

Operator Review

↓

Publish Snapshot

↓

Generate Reports (news section auto-populates from fresh news service)

## Target

Less than 15 minutes of operator intervention per week.

## News Freshness Gate

Reports include a brand news section pulled live from news.dlrtools.com.
The home page dashboard shows a green/amber status indicator.
Green = news ran this ISO week. Amber = stale — run news before publishing reports.

---

# Non-Goals

Not a full website crawler.

Not chatbot automation.

Not form automation.

Not AI-driven navigation.

Not real-time monitoring.

Not a compliance engine (compliance logic lives in an external service).

Scope is limited to dealership promotional and offer intelligence.
