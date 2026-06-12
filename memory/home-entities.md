---
name: home-entities
description: Rules for which HA entities to use when controlling specific devices
metadata:
  type: feedback
---

## Dining / Entrance Lights — use software-level entity, not gang/relay

When turning dining hall lights on/off, use the **software-level smart light entity** (e.g. `light.dining_smart_bulbs`, `light.dining_smart_bulb_1/2`), never the **gang/relay-level entity** (the physical wall-switch relay, e.g. `switch.entrance_dining_left` — friendly name "Dining Light", controls relay-level power).

Note: `light.entrance_dining_left` was previously a relay-level entity exposed in the `light.*` domain (hidden in HA). Bernard has since renamed/reclassified it to `switch.entrance_dining_left`. Don't assume a `light.*` domain entity is automatically software-level — check whether it's actually relay/gang level before using it.

**Why:** Bernard corrected this directly (2026-06-07). The dining lights are smart bulbs — the gang/relay entity only controls power to the bulb's circuit, not its actual on/off+brightness state, so toggling the relay can desync from the bulb's real state.

**How to apply:** For dining/entrance lights, prefer `light.dining_smart_bulbs` (or the individual `light.dining_smart_bulb_1/2`) over any `switch.*entrance_dining*` relay entity. If unsure whether an entity is relay-level vs software-level, ask Bernard rather than guessing from the domain prefix alone.
