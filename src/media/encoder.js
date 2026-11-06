// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Persistent per-camera FFmpeg RTSP encoder, drain-aware frame pipe,
 * hardware acceleration fallback, and continuous A/V tickers.
 */
'use strict';

const {spawn} = require('node:child_process');
const {
  cfg,
  W,
  H,
  LIVE_FPS,
  IDLE_FPS,
  AUDIO,
  RATE,
  AUDIO_TICK,
  AUDIO_CHUNK,
  SILENCE,
  SHORT_KEYFRAME_BURST_MS,
  STDERR_TAIL_MAX_CHARS,
  HWACCEL_MODES,
  ACTIVE_HWACCEL,
  HWACCEL_DEVICE,
} = require('../config');
const {log, formatLocalHm} = require('../logger');
const {renderLiveFrameWithCard} = require('../overlay/card-renderer');

/** @typedef {import("../domain/camera").Camera} Camera */

const DOWNLOAD_PACE_LEAD_MS = 4;
const FRESH_FRAME_MAX_AGE_MS = 2000;
const LIVE_HEARTBEAT_WRITE_MS = 500;
const ENCODER_WEDGED_TIMEOUT_MS = 10000;
const HWACCEL_FAIL_WINDOW_MS = 5000;
const HWACCEL_FALLBACK_RESTART_MS = 1000;
const ENCODER_DROP_MIN_UPTIME_MS = 10000;
const ENCODER_RESTART_DELAY_MS = 3000;
const OFFLINE_SNAPSHOT_SEED_MS = 6000;
const OFFLINE_SNAPSHOT_MAX_WAIT_MS = 30000;
const MS_PER_SECOND = 1000;
const HWACCEL_FAILURE_STDERR_REGEX =
  /vaapi|qsv|nvenc|v4l2|hwupload|device|driver|Invalid argument|Function not implemented/i;
const MIN_GOP_FRAMES = 4;
const VAAPI_QP = '18';
const QSV_GLOBAL_QUALITY = '19';
const NVENC_CQ = '19';
const SOFTWARE_CRF = '19';
const MAX_VIDEO_BITRATE = '3500k';
const VIDEO_BUFSIZE = '5000k';
const V4L2_VIDEO_BITRATE = '3000k';
const AUDIO_BITRATE = '32k';
const DEC_PCM_PTS_FILTER = 'asetpts=N/(SR*10)/TB';

/**
 * Fluent builder for constructing immutable FFmpeg CLI argument arrays across encoder, decoder, and cache modules.
 */
class FfmpegArgsBuilder {
  constructor() {
    /** @type {string[]} */
    this._args = [];
  }

  /**
   * Prepends -hide_banner and -loglevel <level>.
   *
   * @param {string} [logLevel='error'] - FFmpeg log level.
   * @returns {this}
   */
  hideBanner(logLevel = 'error') {
    return this.flag('-hide_banner').option('-loglevel', String(logLevel));
  }

  /**
   * Appends low-latency stream demuxing flags (-fflags +genpts -flags low_delay).
   * Avoids +nobuffer so avformat_find_stream_info retains initial probed keyframe packets (Frame 0).
   *
   * @returns {this}
   */
  withLowLatencyFlags() {
    this._args.push('-fflags', '+genpts', '-flags', 'low_delay');
    return this;
  }

  /**
   * Appends raw YUV420p stdout video output flags (-pix_fmt yuv420p -fps_mode passthrough -f rawvideo pipe:1).
   *
   * @returns {this}
   */
  withRawYuvOutput() {
    this._args.push('-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1');
    return this;
  }

  /**
   * Appends s16le mono PCM audio output pipe arguments when audio is enabled.
   * Uses asetpts=N/(SR*10)/TB so s16le output receives strictly monotonic sample-counted
   * timestamps without aresample=async=1 dropping burst-transferred backfill samples and
   * without FFmpeg's muxer scheduler stalling pipe:3 -> pipe:4 audio when pipe:1 rawvideo
   * is paused at the backpressure high watermark.
   *
   * @param {boolean} enabled - Whether audio output is enabled.
   * @param {string} mapSpec - Input audio stream map specifier ('1:a' or '0:a:0?').
   * @param {number} sampleRate - Output sample rate in Hz.
   * @returns {this}
   */
  withS16leAudioOutput(enabled, mapSpec, sampleRate) {
    if (enabled) {
      this._args.push(
          '-map',
          mapSpec,
          '-af',
          DEC_PCM_PTS_FILTER,
          '-ar',
          String(sampleRate),
          '-ac',
          '1',
          '-f',
          's16le',
          'pipe:4'
      );
    }
    return this;
  }

  /**
   * Appends a single CLI flag without value (e.g. '-an' or '-y').
   *
   * @param {string} flagName - CLI flag.
   * @returns {this}
   */
  flag(flagName) {
    this._args.push(String(flagName));
    return this;
  }

  /**
   * Appends a CLI key-value option pair.
   *
   * @param {string} key - Option flag (e.g. '-f').
   * @param {string|number} value - Option value.
   * @returns {this}
   */
  option(key, value) {
    this._args.push(String(key), String(value));
    return this;
  }

  /**
   * Appends one or more raw CLI tokens.
   *
   * @param {...(string|number)} items - Tokens to append.
   * @returns {this}
   */
  append(...items) {
    for (const item of items) {
      this._args.push(String(item));
    }
    return this;
  }

  /**
   * Appends the final output target URI or pipe specifier.
   *
   * @param {string} target - Output path, URL, or pipe.
   * @returns {this}
   */
  output(target) {
    this._args.push(String(target));
    return this;
  }

  /**
   * Returns a frozen copy of the constructed FFmpeg CLI argument array.
   *
   * @returns {ReadonlyArray<string>}
   */
  build() {
    return Object.freeze([...this._args]);
  }

  /**
   * Attaches a bounded rolling stderr tail listener to an FFmpeg child process.
   *
   * @param {import("child_process").ChildProcess} proc - Spawned FFmpeg child process.
   * @param {number} [maxChars=STDERR_TAIL_MAX_CHARS] - Maximum tail buffer characters.
   * @returns {{ getRaw: () => string, getSummary: () => string, getLastLine: () => string }}
   */
  static attachStderrTailCollector(proc, maxChars = STDERR_TAIL_MAX_CHARS) {
    let tail = '';
    if (proc && proc.stderr) {
      proc.stderr.on('data', (d) => {
        tail = (tail + d).slice(-maxChars);
      });
    }
    return Object.freeze({
      getRaw: () => tail,
      getSummary: () => tail.trim().split('\n').join(' | '),
      getLastLine: () => tail.trim().split('\n').pop() || 'no stderr output',
    });
  }
}

let onEncoderDropCallback = null;
let isShuttingDownFn = () => false;

/**
 * Registers lifecycle callbacks used by the encoder manager when an established
 * encoder process exits or when checking shutdown state.
 *
 * @param {{ isShuttingDown?: () => boolean, onEncoderDrop?: () => void }} hooks - Lifecycle hooks.
 */
function configureEncoderHooks(hooks = {}) {
  if (typeof hooks.isShuttingDown === 'function') {
    isShuttingDownFn = hooks.isShuttingDown;
  }
  if (typeof hooks.onEncoderDrop === 'function') {
    onEncoderDropCallback = hooks.onEncoderDrop;
  }
}

/**
 * Advances the buffered download frame queue by one frame at LIVE_FPS pacing when a camera
 * is replaying a post-event HomeBase clip download.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function advanceDownloadPlaybackFrame(cam, now) {
  const frameIntervalMs = Math.floor(MS_PER_SECOND / LIVE_FPS) - DOWNLOAD_PACE_LEAD_MS;
  cam.consumeNextDownloadFrame(now, frameIntervalMs, formatLocalHm(new Date(now)));
}

/**
 * Advances the buffered live burst frame queue by one frame at LIVE_FPS pacing when a live
 * RTSP or P2P stream delivers multi-frame Wi-Fi/TCP bursts.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function advanceLivePlaybackFrame(cam, now) {
  const frameIntervalMs = Math.floor(MS_PER_SECOND / LIVE_FPS) - DOWNLOAD_PACE_LEAD_MS;
  cam.consumeNextLiveFrame(now, frameIntervalMs, formatLocalHm(new Date(now)));
}

/**
 * Selects the source YUV420p frame buffer to feed to the camera's encoder (raw live video,
 * clean snapshot fallback, waking card, busy card, or asleep card).
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {{ frame: Uint8Array, isLive: boolean }}
 */
function selectEncoderFrame(cam, now) {
  return cam.selectEncoderFrame(now, FRESH_FRAME_MAX_AGE_MS);
}

/**
 * Determines whether a frame should be written to the FFmpeg encoder stdin on the current tick.
 *
 * @param {Camera} cam - Camera state object.
 * @param {boolean} isLive - Whether the camera is currently streaming live video.
 * @param {boolean} stateChanged - Whether the selected frame buffer changed since last write.
 * @param {boolean} inBurst - Whether the camera is in a keyframe burst window.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function shouldWriteEncoderFrame(cam, isLive, stateChanged, inBurst, now) {
  return cam.shouldWriteEncoderFrame(
      isLive,
      stateChanged,
      inBurst,
      now,
      LIVE_FPS,
      IDLE_FPS,
      DOWNLOAD_PACE_LEAD_MS,
      LIVE_HEARTBEAT_WRITE_MS
  );
}

/**
 * Pushes the appropriate video frame to a camera's persistent FFmpeg encoder stdin.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function pushFrameToEncoder(cam, now = Date.now()) {
  if (!cam.hasWritableEncoderStdin()) {
    return;
  }
  if (cam.isEncoderStdinBackpressured()) {
    if (cam.isEncoderWedged(now, ENCODER_WEDGED_TIMEOUT_MS)) {
      log.error(
          cam,
          'encoder stdin wedged for >10s (initiator=bridge-watchdog, reason=encoder_stdin_backpressure), killing encoder process'
      );
      cam.killWedgedEncoder();
    }
    return;
  }

  advanceDownloadPlaybackFrame(cam, now);
  advanceLivePlaybackFrame(cam, now);
  const {frame, isLive} = selectEncoderFrame(cam, now);
  const stateChanged = cam.hasEncoderSourceChanged(frame);
  if (stateChanged && !isLive) {
    cam.triggerKeyframeBurst(now, SHORT_KEYFRAME_BURST_MS);
  }
  const inBurst = cam.isInKeyframeBurst(now);

  if (shouldWriteEncoderFrame(cam, isLive, stateChanged, inBurst, now)) {
    const outFrame =
        (isLive || cam.hasDynamicDebugCard()) && frame
            ? renderLiveFrameWithCard(cam, frame, now)
            : frame;
    cam.writeEncoderVideoFrame(outFrame, frame, now);
  }
}

/**
 * Builds the video encoder codec arguments for the requested hardware acceleration mode.
 *
 * @param {string} hwMode - Hardware acceleration mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m', or '').
 * @param {string} gop - Keyframe interval (GOP size) string.
 * @returns {readonly string[]}
 */
function buildVideoCodecArgs(hwMode, gop) {
  switch (hwMode) {
    case HWACCEL_MODES.VAAPI:
      return Object.freeze([
        '-vf',
        'format=nv12,hwupload',
        '-c:v',
        'h264_vaapi',
        '-bf',
        '0',
        '-qp',
        VAAPI_QP,
        '-g',
        gop,
      ]);
    case HWACCEL_MODES.QSV:
      return Object.freeze([
        '-vf',
        'format=nv12,hwupload=extra_hw_frames=64',
        '-c:v',
        'h264_qsv',
        '-global_quality',
        QSV_GLOBAL_QUALITY,
        '-maxrate',
        MAX_VIDEO_BITRATE,
        '-bufsize',
        VIDEO_BUFSIZE,
        '-g',
        gop,
      ]);
    case HWACCEL_MODES.NVENC:
      return Object.freeze([
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p3',
        '-tune',
        'ull',
        '-pix_fmt',
        'yuv420p',
        '-cq',
        NVENC_CQ,
        '-maxrate',
        MAX_VIDEO_BITRATE,
        '-bufsize',
        VIDEO_BUFSIZE,
        '-g',
        gop,
      ]);
    case HWACCEL_MODES.V4L2M2M:
      return Object.freeze(['-c:v', 'h264_v4l2m2m', '-pix_fmt', 'yuv420p', '-b:v', V4L2_VIDEO_BITRATE, '-g', gop]);
    default:
      return Object.freeze([
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        SOFTWARE_CRF,
        '-maxrate',
        MAX_VIDEO_BITRATE,
        '-bufsize',
        VIDEO_BUFSIZE,
        '-g',
        gop,
      ]);
  }
}

/**
 * Builds the full FFmpeg CLI argument list for a camera's persistent RTSP encoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} [hwMode=''] - Hardware acceleration mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m', or '').
 * @returns {ReadonlyArray<string>}
 */
function buildEncoderArgs(cam, hwMode = '') {
  const gop = String(Math.max(MIN_GOP_FRAMES, LIVE_FPS));
  const builder = new FfmpegArgsBuilder().hideBanner('warning');

  switch (hwMode) {
    case HWACCEL_MODES.VAAPI:
      builder.option('-init_hw_device', 'vaapi=va:' + HWACCEL_DEVICE).option('-filter_hw_device', 'va');
      break;
    case HWACCEL_MODES.QSV:
      builder.option('-init_hw_device', 'qsv=hw:' + HWACCEL_DEVICE).option('-filter_hw_device', 'hw');
      break;
    default:
      break;
  }

  builder
      .option('-use_wallclock_as_timestamps', '1')
      .option('-f', 'rawvideo')
      .option('-pix_fmt', 'yuv420p')
      .option('-s', W + 'x' + H)
      .option('-i', 'pipe:0');

  if (AUDIO) {
    builder
        .option('-use_wallclock_as_timestamps', '1')
        .option('-f', 's16le')
        .option('-ar', RATE)
        .option('-ac', '1')
        .option('-i', 'pipe:3')
        .option('-map', '0:v')
        .option('-map', '1:a');
  }

  builder.option('-fps_mode', 'passthrough').append(...buildVideoCodecArgs(hwMode, gop));

  if (AUDIO) {
    builder.option('-af', 'aresample=async=1').option('-c:a', 'aac').option('-b:a', AUDIO_BITRATE);
  }
  builder
      .option('-f', 'rtsp')
      .option('-rtsp_transport', 'tcp')
      .output(cfg.rtsp_output_url.replace('{name}', cam.getName()));
  return builder.build();
}

/**
 * Stops a camera's persistent FFmpeg RTSP encoder when the camera is offline so go2rtc and
 * Frigate detect that the stream is offline and display Frigate's offline state.
 *
 * @param {Camera} cam - Camera state object.
 * @returns {boolean} True if an active encoder process was stopped or newly marked paused for offline.
 */
function stopEncoder(cam) {
  const hadProcess = cam.hasEncoderProcess();
  const stopped = cam.pauseEncoderForOffline();
  if (stopped) {
    const reason = cam.getOfflineReason() || 'offline';
    const msg = hadProcess
      ? 'stopping RTSP encoder because camera is offline (' +
        reason +
        ') so Frigate marks device offline'
      : 'camera is offline (' +
        reason +
        ') with no cached snapshot to seed; keeping RTSP encoder stopped so Frigate marks device offline';
    log.warn(cam, msg);
  }
  return stopped;
}

/**
 * Briefly runs an offline camera's RTSP encoder to push its cached snapshot frame to Frigate
 * (on bridge startup or Frigate reload) at 15 fps keyframe burst rate and then stops the encoder
 * so Frigate displays its offline state over the last available snapshot. Stops the encoder
 * immediately without seeding if sleep_screen is not "snapshot" or no cached snapshot exists.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} [seedDurationMs=OFFLINE_SNAPSHOT_MAX_WAIT_MS] - Max wait duration in milliseconds before stopping the encoder.
 * @returns {'online'|'stopped'|'seeded'} Resulting offline snapshot seed action.
 */
function seedOfflineCameraSnapshot(cam, seedDurationMs = OFFLINE_SNAPSHOT_MAX_WAIT_MS) {
  if (!cam.isDeviceOffline()) {
    return 'online';
  }
  if (!cam.hasOfflineSnapshotToSeed()) {
    stopEncoder(cam);
    return 'stopped';
  }
  const now = Date.now();
  const waitMs = Math.max(1, Number(seedDurationMs) || OFFLINE_SNAPSHOT_MAX_WAIT_MS);
  if (!cam.hasEncoderProcess()) {
    startEncoder(cam, true);
  }
  cam.triggerKeyframeBurst(now, waitMs + SHORT_KEYFRAME_BURST_MS);
  pushFrameToEncoder(cam, now);
  cam.markEncoderStoppedForOffline();
  log.info(
      cam,
      'seeding cached snapshot to Frigate before stopping offline encoder (' +
      (cam.getOfflineReason() || 'offline') +
      ')'
  );
  cam.scheduleOfflineSeedStop(waitMs, () => {
    if (cam.isDeviceOffline() && !isShuttingDownFn()) {
      stopEncoder(cam);
    }
  });
  return 'seeded';
}

/**
 * Seeds cached snapshots for any offline cameras in cams that have a valid snapshot and
 * sleep_screen="snapshot" (used when Frigate recovers or reloads).
 *
 * @param {Camera[]} cams - Array of Camera instances.
 * @param {number} [seedDurationMs=OFFLINE_SNAPSHOT_MAX_WAIT_MS] - Max wait duration in milliseconds.
 */
function seedOfflineCameraSnapshots(cams, seedDurationMs = OFFLINE_SNAPSHOT_MAX_WAIT_MS) {
  if (!Array.isArray(cams)) {
    return;
  }
  for (const cam of cams) {
    if (cam && cam.isDeviceOffline() && cam.hasOfflineSnapshotToSeed()) {
      seedOfflineCameraSnapshot(cam, seedDurationMs);
    }
  }
}

/**
 * Spawns the persistent FFmpeg encoder process for a camera.
 *
 * @param {Camera} cam - Camera state object.
 * @param {boolean} [allowOfflineSeed=false] - Whether to allow spawning while offline for snapshot seeding.
 */
function startEncoder(cam, allowOfflineSeed = false) {
  if (
      isShuttingDownFn() ||
      cam.hasEncoderProcess() ||
      (cam.isDeviceOffline() && !allowOfflineSeed)
  ) {
    return;
  }

  const wasPausedForOffline = !allowOfflineSeed && cam.clearEncoderOfflinePause();
  const hwMode = cam.resolveActiveHwaccel(ACTIVE_HWACCEL);
  const args = buildEncoderArgs(cam, hwMode);
  const spawnAt = Date.now();
  const enc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe', AUDIO ? 'pipe' : 'ignore'],
  });

  cam.attachEncoder(enc, spawnAt);
  pushFrameToEncoder(cam, spawnAt);

  enc.on('error', (e) => log.error(cam, 'encoder process error: ' + e.message));
  enc.stdin.on('error', () => {});
  enc.stdin.on('drain', () => {
    const frameIntervalMs = Math.floor(MS_PER_SECOND / LIVE_FPS) - DOWNLOAD_PACE_LEAD_MS;
    if (cam.shouldDrainEncoderOnReady(Date.now(), frameIntervalMs)) {
      pushFrameToEncoder(cam);
    }
  });
  if (AUDIO && enc.stdio[3]) {
    enc.stdio[3].on('error', () => {});
  }

  const stderrCollector = FfmpegArgsBuilder.attachStderrTailCollector(enc, STDERR_TAIL_MAX_CHARS);

  enc.on('exit', (code) => {
    const wasAttached = cam.detachEncoderIfMatch(enc);
    if (
        isShuttingDownFn() ||
        !wasAttached ||
        (cam.isDeviceOffline() && !cam.isSeedingOfflineSnapshot())
    ) {
      return;
    }
    const tail = stderrCollector.getRaw();
    const errSummary = stderrCollector.getSummary();

    if (
        hwMode &&
        Date.now() - spawnAt < HWACCEL_FAIL_WINDOW_MS &&
        HWACCEL_FAILURE_STDERR_REGEX.test(tail)
    ) {
      cam.disableHwaccel();
      log.warn(
          cam,
          'hwaccel (' +
          hwMode +
          ') encoder failed (' +
          errSummary +
          '), falling back to software libx264'
      );
      setTimeout(() => {
        if (!cam.hasEncoderProcess() && !isShuttingDownFn()) {
          startEncoder(cam, cam.isSeedingOfflineSnapshot());
        }
      }, HWACCEL_FALLBACK_RESTART_MS).unref();
      return;
    }

    log.error(cam, 'encoder exited (code=' + code + ') ' + errSummary + ' - restarting in 3 s');
    if (Date.now() - spawnAt > ENCODER_DROP_MIN_UPTIME_MS && onEncoderDropCallback) {
      onEncoderDropCallback();
    }
    setTimeout(() => {
      if (!cam.hasEncoderProcess() && !isShuttingDownFn()) {
        startEncoder(cam, cam.isSeedingOfflineSnapshot());
      }
    }, ENCODER_RESTART_DELAY_MS).unref();
  });

  const codecLabel = hwMode ? 'h264_' + hwMode : 'libx264';
  const resumeSuffix = wasPausedForOffline ? ' (resumed after offline recovery)' : '';
  log.info(cam, 'encoder (' + codecLabel + ') publishing to go2rtc' + resumeSuffix);
}

/**
 * Starts the periodic video frame ticker (at LIVE_FPS) and 100ms PCM audio ticker
 * across all configured cameras.
 *
 * @param {Camera[]} cams - Array of Camera instances.
 */
function startMediaTickers(cams) {
  setInterval(() => {
    const now = Date.now();
    for (const cam of cams) {
      pushFrameToEncoder(cam, now);
    }
  }, Math.round(MS_PER_SECOND / LIVE_FPS));

  if (AUDIO) {
    setInterval(() => {
      for (const cam of cams) {
        cam.writeEncoderAudioTick(AUDIO_CHUNK, SILENCE);
      }
    }, AUDIO_TICK);
  }
}

module.exports = {
  OFFLINE_SNAPSHOT_SEED_MS,
  FfmpegArgsBuilder,
  configureEncoderHooks,
  selectEncoderFrame,
  shouldWriteEncoderFrame,
  pushFrameToEncoder,
  buildVideoCodecArgs,
  buildEncoderArgs,
  stopEncoder,
  seedOfflineCameraSnapshot,
  seedOfflineCameraSnapshots,
  startEncoder,
  startMediaTickers,
};
