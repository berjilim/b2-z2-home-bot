---
name: home-deductions
description: Deduction rules for inferring room/device state from indirect HA signals
metadata:
  type: feedback
---

## Master Toilet Occupancy

No dedicated presence sensor. Infer state from correlated signals:

- **Venting mode active** → toilet is **empty** (being ventilated after use). Detect via: `automation.switch_double_press_vent_60mins_master_toilet_v2` is running, or `switch.master_toilet` is OFF while exhaust fan is on.
- **Light ON** (`switch.master_toilet` = ON, no venting) → someone is likely inside.
- **Everything off** → toilet is idle and unoccupied.

`binary_sensor.floorplan_master_toilet_state` being "on" does NOT reliably indicate presence — it can reflect venting mode. Always cross-check the venting automation state before concluding someone is in there.

**Why:** Bernard corrected this directly (2026-06-07). Venting mode was active; floorplan sensor was "on" but toilet was empty.

**How to apply:** When asked about master toilet occupancy, check venting automation state first. If venting is running, answer: empty, ventilating after use.
