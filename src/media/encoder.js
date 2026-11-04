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

const {spawn} = require('child_process');
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
const MIN_GOP_FRAMES = 4;
const VAAPI_QP = '18';
const QSV_GLOBAL_QUALITY = '19';
const NVENC_CQ = '19';
const SOFTWARE_CRF = '19';
const MAX_VIDEO_BITRATE = '3500k';
const VIDEO_BUFSIZE = '5000k';
const V4L2_VIDEO_BITRATE = '3000k';
const AUDIO_BITRATE = '32k';

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
  const frameIntervalMs = Math.floor(1000 / LIVE_FPS) - DOWNLOAD_PACE_LEAD_MS;
  cam.consumeNextDownloadFrame(now, frameIntervalMs, formatLocalHm(new Date(now)));
}

/**
 * Selects the YUV420p frame buffer to feed to the camera's encoder (live video with optional
 * corner card, clean snapshot fallback, waking card, busy card, or asleep card).
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {{ frame: Uint8Array, isLive: boolean }}
 */
function selectEncoderFrame(cam, now) {
  if (cam.isStreamingLive(now, FRESH_FRAME_MAX_AGE_MS)) {
    const rawLiveFrame = cam.hasFreshFrame(now, FRESH_FRAME_MAX_AGE_MS) ? cam.frame : cam.lastFrame;
    const liveFrame = rawLiveFrame ? renderLiveFrameWithCard(cam, rawLiveFrame) : rawLiveFrame;
    return {frame: liveFrame, isLive: true};
  }
  if (cam.card.suppressLiveCard && Buffer.isBuffer(cam.lastFrame)) {
    return {frame: cam.lastFrame, isLive: false};
  }
  if (cam.active) {
    return {frame: cam.card.waking, isLive: false};
  }
  if (now < cam.wantUntil()) {
    return {frame: cam.card.busy, isLive: false};
  }
  return {frame: cam.card.asleep, isLive: false};
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
  const elapsedMs = now - cam.lastWrite;
  if (isLive) {
    return Boolean(cam.frameNew || elapsedMs >= LIVE_HEARTBEAT_WRITE_MS);
  }
  return Boolean(stateChanged || inBurst || elapsedMs >= 1000 / IDLE_FPS);
}

/**
 * Pushes the appropriate video frame to a camera's persistent FFmpeg encoder stdin.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function pushFrameToEncoder(cam, now = Date.now()) {
  const enc = cam.enc;
  if (!enc || !enc.stdin || !enc.stdin.writable) {
    return;
  }
  if (enc.stdin.writableNeedDrain) {
    if (now - cam.lastWrite > ENCODER_WEDGED_TIMEOUT_MS) {
      log.error(
          cam,
          'encoder stdin wedged for >10s (initiator=bridge-watchdog, reason=encoder_stdin_backpressure), killing encoder process'
      );
      try {
        enc.kill('SIGKILL');
      } catch (err) {
        // Ignore kill errors on wedged encoder.
      }
    }
    return;
  }

  advanceDownloadPlaybackFrame(cam, now);
  const {frame, isLive} = selectEncoderFrame(cam, now);
  const stateChanged = frame !== cam.lastSent;
  if (stateChanged) {
    cam.triggerKeyframeBurst(now, SHORT_KEYFRAME_BURST_MS);
  }
  const inBurst = cam.isInKeyframeBurst(now);

  if (shouldWriteEncoderFrame(cam, isLive, stateChanged, inBurst, now)) {
    enc.stdin.write(frame);
    cam.markFrameEncoded(frame, now);
  }
}

/**
 * Builds the video encoder codec arguments for the requested hardware acceleration mode.
 *
 * @param {string} hwMode - Hardware acceleration mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m', or '').
 * @param {string} gop - Keyframe interval (GOP size) string.
 * @returns {string[]}
 */
function buildVideoCodecArgs(hwMode, gop) {
  switch (hwMode) {
    case 'vaapi':
      return [
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
      ];
    case 'qsv':
      return [
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
      ];
    case 'nvenc':
      return [
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
      ];
    case 'v4l2m2m':
      return ['-c:v', 'h264_v4l2m2m', '-pix_fmt', 'yuv420p', '-b:v', V4L2_VIDEO_BITRATE, '-g', gop];
    default:
      return [
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
      ];
  }
}

/**
 * Builds the full FFmpeg CLI argument list for a camera's persistent RTSP encoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} hwMode - Hardware acceleration mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m', or '').
 * @returns {string[]}
 */
function buildEncoderArgs(cam, hwMode) {
  const gop = String(Math.max(MIN_GOP_FRAMES, LIVE_FPS));
  const args = ['-hide_banner', '-loglevel', 'warning'];

  if (hwMode === 'vaapi') {
    args.push('-init_hw_device', 'vaapi=va:' + HWACCEL_DEVICE, '-filter_hw_device', 'va');
  } else if (hwMode === 'qsv') {
    args.push('-init_hw_device', 'qsv=hw:' + HWACCEL_DEVICE, '-filter_hw_device', 'hw');
  }

  args.push(
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-s',
      W + 'x' + H,
      '-i',
      'pipe:0'
  );

  if (AUDIO) {
    args.push(
        '-use_wallclock_as_timestamps',
        '1',
        '-f',
        's16le',
        '-ar',
        String(RATE),
        '-ac',
        '1',
        '-i',
        'pipe:3',
        '-map',
        '0:v',
        '-map',
        '1:a'
    );
  }

  args.push('-fps_mode', 'passthrough', ...buildVideoCodecArgs(hwMode, gop));

  if (AUDIO) {
    args.push('-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', AUDIO_BITRATE);
  }
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', cfg.rtsp_publish.replace('{name}', cam.name));
  return args;
}

/**
 * Spawns the persistent FFmpeg encoder process for a camera.
 *
 * @param {Camera} cam - Camera state object.
 */
function startEncoder(cam) {
  if (isShuttingDownFn() || cam.enc) {
    return;
  }

  const hwMode = cam.useHwaccel ? ACTIVE_HWACCEL : '';
  const args = buildEncoderArgs(cam, hwMode);
  const spawnAt = Date.now();
  const enc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe', AUDIO ? 'pipe' : 'ignore'],
  });

  cam.attachEncoder(enc, spawnAt);

  enc.on('error', (e) => log.error(cam, 'encoder process error: ' + e.message));
  enc.stdin.on('error', () => {});
  enc.stdin.on('drain', () => {
    if (cam.frameNew) {
      pushFrameToEncoder(cam);
    }
  });
  if (AUDIO && enc.stdio[3]) {
    enc.stdio[3].on('error', () => {});
  }

  let tail = '';
  enc.stderr.on('data', (d) => {
    tail = (tail + d).slice(-STDERR_TAIL_MAX_CHARS);
  });

  enc.on('exit', (code) => {
    if (cam.enc === enc) {
      cam.enc = null;
    }
    if (isShuttingDownFn()) {
      return;
    }
    const errSummary = tail.trim().split('\n').join(' | ');

    if (
        hwMode &&
        Date.now() - spawnAt < HWACCEL_FAIL_WINDOW_MS &&
        /vaapi|qsv|nvenc|v4l2|hwupload|device|driver|Invalid argument|Function not implemented/i.test(tail)
    ) {
      cam.useHwaccel = false;
      log.warn(
          cam,
          'hwaccel (' +
          hwMode +
          ') encoder failed (' +
          errSummary +
          '), falling back to software libx264'
      );
      setTimeout(() => {
        if (!cam.enc && !isShuttingDownFn()) {
          startEncoder(cam);
        }
      }, HWACCEL_FALLBACK_RESTART_MS);
      return;
    }

    log.error(cam, 'encoder exited (code=' + code + ') ' + errSummary + ' - restarting in 3 s');
    if (Date.now() - spawnAt > ENCODER_DROP_MIN_UPTIME_MS && onEncoderDropCallback) {
      onEncoderDropCallback();
    }
    setTimeout(() => {
      if (!cam.enc && !isShuttingDownFn()) {
        startEncoder(cam);
      }
    }, ENCODER_RESTART_DELAY_MS);
  });

  const codecLabel = hwMode ? 'h264_' + hwMode : 'libx264';
  log.info(cam, 'encoder (' + codecLabel + ') publishing to go2rtc');
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
  }, Math.round(1000 / LIVE_FPS));

  if (AUDIO) {
    setInterval(() => {
      for (const cam of cams) {
        const enc = cam.enc;
        if (!enc || !enc.stdio[3] || !enc.stdio[3].writable || enc.stdio[3].writableNeedDrain) {
          continue;
        }
        enc.stdio[3].write(cam.consumeAudioChunk(AUDIO_CHUNK, SILENCE));
      }
    }, AUDIO_TICK);
  }
}

module.exports = {
  configureEncoderHooks,
  pushFrameToEncoder,
  startEncoder,
  startMediaTickers,
};
