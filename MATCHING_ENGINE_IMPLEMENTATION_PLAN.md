# Matching Engine - Phase Plan & Status

Last updated: 2026-02-20

## Current Status Snapshot

### Phase 1 / Sprint 1 - Core Strict Matcher (Completed)
- queue intake and request lifecycle
- hard-filter compatibility checks
- 5-person group formation
- strict gender ratio (`2F:3M` or `3F:2M`)
- matched-group to found-meet generation
- strict `/meets/found` mode (no auto found without match)
- admin seed endpoint for deterministic strict-mode testing

### Phase 1 / Sprint 1.1 - Completion Status (Completed)
- controlled fallback strategy:
  - `STRICT` -> exact `2F:3M` or `3F:2M`
  - `RELAXED_MIXED` -> at least one male + one female
  - `RELAXED_ANY` -> any composition
- explicit SLA states exposed via match request payload:
  - `SEARCHING`, `NO_MATCH_RETRYING`, `MATCHED`, `CANCELLED`, `EXPIRED`
- stronger anti-starvation fairness:
  - boosts from average queue age
  - boosts from oldest member in candidate group
  - boosts from prior `NO_MATCH` retries

### Phase 2 / Sprint 2 - Quality & Intelligence (Pending)
- repeat-pair penalty and diversity balancing
- audio signal integration into scoring
- explainability improvements for match decisions

### Phase 3 / Sprint 3 - Production Hardening (Pending)
- abuse/rate-limiting and operational safeguards
- metrics/alerting with queue health SLOs
- formalized migration/rollback + reliability playbooks

## Objective (Phase 1)
Ship a usable strict matching backend slice with:
- queue intake
- hard-filter matching
- 5-person group formation
- strict gender ratio constraint
- meet generation for frontend found-flow

## APIs (Sprint 1)

1. `POST /api/v1/match-requests`
- Auth required.
- Creates a queued match request.
- Triggers matching cycle immediately.

Request body:
```json
{
  "availability_date": "2026-02-20",
  "availability_slot": "Today",
  "vibe": "Coffee",
  "age_min": 22,
  "age_max": 33,
  "lat": 12.9716,
  "lng": 77.5946,
  "radius_km": 12,
  "voice_duration_sec": 18
}
```

2. `GET /api/v1/match-requests/active`
- Auth required.
- Returns latest request for user with status/score/group reference.

## Data Collections

Stored in runtime store + Postgres mode:
- `matchRequests`
- `matchGroups`
- `matchGroupMembers`
- `matchEvents`

Prisma models:
- `MatchRequest`
- `MatchGroup`
- `MatchGroupMember`
- `MatchEvent`

## Matching Cycle (Sprint 1)

Triggered by:
- request creation
- background interval (`MATCHER_INTERVAL_MS`, default `7000`)

Algorithm:
1. Take queued requests (oldest-first anchor).
2. Build candidate pool for anchor with hard compatibility.
3. Generate combinations to reach group size 5.
4. Enforce constraints:
   - all pairwise hard-compatible
   - gender ratio exactly `2F:3M` or `3F:2M`
5. Pick highest compatibility score group.
6. Mark requests as `MATCHED`, create group + members + events.
7. Create user-facing `FOUND` meet objects for each matched user (if no open meet exists).

## Hard Filters (Sprint 1)

- profile must exist (onboarding complete)
- exclude `Other` gender from current ratio-constrained grouping
- blocked-user exclusion in both directions
- availability date/slot compatibility
- vibe exact match (if both provided)
- age-range overlap
- geo radius compatibility (haversine distance vs minimum radius)

## Scoring (Sprint 1 basic)

Pair score starts at 100 and penalizes:
- vibe mismatch
- larger distance

Pair score boosts:
- better age overlap

Group score = average of pair scores.

## Notes

- This is intentionally strict and deterministic for pilot safety.
- “No match yet” remains possible if constraints fail.
- Future versions can add soft fallbacks and embedding-based audio compatibility.

## Next Sprint (Phase 2 focus)

1. Repeat-pair penalty and diversity balancing.
2. Audio signal integration into scoring.
3. Explainability improvements for why a group was matched.
