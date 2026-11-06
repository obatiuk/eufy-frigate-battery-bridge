# 5. Center Overlay False Motion & Black Screens on Rapid Camera Switching

- **Cause 1:** The centered `820x336` modal cannot be masked in Frigate without blinding center-frame motion
  detection.
- **Cause 2:** A 10-second keyframe interval (`-g 20` at `2 fps`) and resetting `sleptAt` on card rebuilds caused
  MSE/WebRTC players to show a black screen or hit false cooldowns when clicking cameras sequentially.
- **Fix:** Unified placement under `card_position` (`center` + 4 corners) with frosted-glass `detailed`, `icons`,
  `minimal`, and `none` themes; added event-driven frame pushing, `2s` keyframe bursts on viewer connect/state change,
  and `750ms` viewer polling.
