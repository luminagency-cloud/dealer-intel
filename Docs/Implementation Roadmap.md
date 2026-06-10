# Dealer Offer Intelligence Platform

# Implementation Roadmap

## Guiding Principles

This system is a dealer offer intelligence platform.

It is not a website scraper.

Collection is only one subsystem.

The platform exists to:

1. Collect dealership offers.
2. Preserve evidence.
3. Normalize offers into structured data.
4. Maintain historical snapshots.
5. Generate competitive intelligence reports.

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

Defines business information to collect.

Examples:

* Homepage Offers
* Service Specials
* Finance Offers
* Promotional Banners

### Collection Runs

Represents a complete collection attempt.

### Evidence

Represents screenshots, disclaimers, and HTML captures.

### Offers

Represents normalized offer records.

### Report Snapshots

Represents approved reporting datasets.

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

Understand offer types

Generate reports

Normalize data

Use AI

## Success Criteria

Collector can visit sites and collect evidence.

---

# Phase 6 - Mission Framework

## Goal

Make collection mission-driven.

## Initial Missions

Homepage Offers

Finance Offers

Service Specials

Promotional Banners

## Mission Responsibilities

Define likely URLs

Define discovery rules

Define expected content

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

# Phase 8 - Site Learning

## Goal

Reduce collection cost over time.

## Stored Knowledge

Last Successful URL

Mission Success Rate

Platform Type

Known Mission Locations

Last Successful Collection

## Collection Order

1. Last Successful URL

2. Site-Specific Alternatives

3. Platform Defaults

4. Mission Discovery Rules

5. AI Fallback (future)

## Success Criteria

Collector improves over time without additional coding.

---

# Phase 9 - Offer Discovery

## Goal

Identify candidate offers from collected evidence.

## Inputs

Screenshots

HTML

Mission Context

## Outputs

Candidate Offers

Candidate Disclaimers

Candidate Promotions

## Responsibilities

Determine:

* Is this an offer?
* Is this promotional content?
* Should it be reviewed?

## Success Criteria

Offer candidates can be extracted from evidence.

---

# Phase 10 - Offer Normalization

## Goal

Convert discovered offers into structured data.

## Supported Types

Lease Offers

Finance Offers

Cash Offers

Service Offers

Promotional Offers

## Output Fields

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

## Success Criteria

Offers become structured records suitable for reporting.

---

# Phase 11 - Snapshot Publishing

## Goal

Separate collection from reporting.

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

# Phase 12 - Reporting Engine

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

## Success Criteria

Reports can be generated without rerunning collection.

---

# Phase 13 - AI Enhancements

## Goal

Improve difficult collection scenarios.

## Appropriate AI Tasks

Offer Classification

Visual Offer Detection

Disclaimer Extraction

Offer Normalization Assistance

Complex Discovery Assistance

## Avoid AI For

Routine Navigation

Routine Collection

Known Mission Paths

Basic Exploration

## Success Criteria

AI improves collection quality while remaining a secondary system.

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

Scheduled Run

↓

Collection

↓

Review Queue

↓

Operator Corrections

↓

Retry Failed Missions

↓

Publish Snapshot

↓

Generate Reports

## Target

Less than 15 minutes of operator intervention per week.

---

# Non-Goals

Not a full website crawler.

Not inventory management.

Not chatbot automation.

Not form automation.

Not AI-driven navigation.

Not real-time monitoring.

Scope is limited to dealership promotional and offer intelligence.
