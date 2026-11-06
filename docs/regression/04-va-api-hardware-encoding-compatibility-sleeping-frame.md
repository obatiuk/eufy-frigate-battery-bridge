# 4. VA-API Hardware Encoding Compatibility & Sleeping Frame Sharpness

- **Cause:** `alpine:3.20` ships `Mesa 24.0.9`, which lacks encode profile tables for newer VA-API GPUs, rejects
  B-frames by default on those encoders, and `-qp 24` with default JPEG caching softened dark sleeping snapshots.
- **Fix:** Upgraded runtime base image to `alpine:3.23` (`Mesa 25.2+`) with `mesa-va-gallium`, set `-bf 0 -qp 18` on
  `h264_vaapi`, added `-q:v 2` to cached JPEG snapshots, and enabled `flags=lanczos` scaling.
