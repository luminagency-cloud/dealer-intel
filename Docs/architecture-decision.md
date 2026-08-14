# Architecture Decisions

## AD-001: System Identity

The platform is a dealer offer intelligence system.

It is not a website scraper.

Collection, Analyis and Reporting are three subsystems among many. They do not know about each other.

---

## AD-002: Sites Are Generic

All websites are stored as Sites.

Competitor relationships are stored separately.

Collection does not know about competitors.

Reporting does.

---

## AD-003: Mission-Driven Collection

Collection is driven by Missions.

Examples:

- Homepage Offers
- Service Specials
- Finance Offers
- Promotional Banners

Collectors execute missions.

Collectors do not understand business meaning.

---

## AD-004: Deterministic Navigation First

Navigation should be deterministic whenever possible.

Order:

1. Known URL
2. Site-specific alternatives
3. Platform defaults
4. Discovery

There is no AI fallback step. If nothing in that order verifies, the mission
fails and asks the operator for a URL rather than guessing.

---

## AD-005: Evidence Is First-Class

Every significant finding should be traceable to evidence.

Evidence may include:

- Screenshots
- Disclaimers
- HTML snapshots
- Source URLs

---

## AD-006: Reports Use Snapshots

Reports never use live collection data.

Reports always use approved snapshots.

---

## AD-007: Human Review Is Expected

Review should only occasionally be part of the normal workflow.

The goal is at least 95% automation.

The goal is low-maintenance operation.

---

## AD-008: Learning Is Stored

Successful mission locations are stored.

Future runs attempt known successful locations first.

---

## AD-009: AI Is Reserved For Interpretation

Preferred AI tasks:

- Offer classification
- Offer normalization
- Visual offer identification
- Disclaimer extraction

Avoid AI for:

- Basic navigation
- Page traversal
- Standard collection flows

---

## AD-010: Storage Separation

Structured data lives in Postgres.

Evidence lives in object storage.

Evidence is referenced from Postgres.
