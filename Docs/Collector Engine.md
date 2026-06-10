# Collector Engine Design

## Collector Responsibilities

The collector executes missions.

The collector does not understand business concepts such as:

* Lease Offers
* Finance Offers
* Service Specials

The collector only understands navigation and evidence gathering.

## Collector Capabilities

* Open page
* Wait for load
* Remove cookie banners
* Remove modal dialogs
* Dismiss chat widgets
* Scroll page
* Expand accordions
* Advance carousels
* Open tabs
* Capture screenshots
* Store evidence

## Mission Execution

Mission
→ Discover Targets
→ Explore Targets
→ Capture Evidence
→ Return Candidates

## Failure Levels

Success

Needs Review

Failure

## Recovery Sequence

1. Known URL
2. Known Site Paths
3. Platform Paths
4. Navigation Discovery
5. AI-Assisted Discovery

## Site Memory

Each mission stores:

* Last Successful URL
* Success Rate
* Last Success Date

Collector always attempts known successful locations first.

## Evidence Types

Homepage Screenshot

Offer Screenshot

Disclaimer Screenshot

Failure Screenshot

Optional HTML Snapshot
