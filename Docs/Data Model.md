# Data Model Design

## sites

Stores all dealer and competitor websites.

Fields:

* id
* name
* url
* platform
* active

## site_relationships

Defines competitor relationships.

Fields:

* site_id
* related_site_id
* relationship_type

Collection does not use this table.

Reporting uses this table.

## collection_runs

Fields:

* id
* started_at
* completed_at
* status

Statuses:

* pending
* review
* completed
* failed

## missions

Fields:

* id
* site_id
* mission_type
* last_known_url
* success_rate
* last_success_at

## evidence

Fields:

* id
* collection_run_id
* site_id
* mission_type
* screenshot_url
* html_url
* evidence_type
* created_at

## offers

Fields:

* id
* collection_run_id
* site_id
* offer_type
* raw_text
* normalized_json
* disclaimer_text
* confidence
* created_at

## report_snapshots

Fields:

* id
* collection_run_id
* approved_at
* approved_by

Reports always reference snapshots.

Never reference live collection data.
