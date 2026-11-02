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
  ACTIVE_HWACCEL,
  HWACCEL_DEVICE,
} = require('../config');
const {log, formatLocalHm} = require('../logger');
const {want} = require('../domain/camera');
const {renderLiveFrameWithCard} = require('../overlay/card-renderer');

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
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function advanceDownloadPlaybackFrame(cam, now) {
  const frameIntervalMs = Math.floor(1000 / LIVE_FPS) - 4;
  if (
      cam.active &&
      cam.activeMode === 'download' &&
      cam.downloadFrames.length > 0 &&
      now - cam.lastWrite >= frameIntervalMs
  ) {
    const nextBuf = cam.downloadFrames.shift();
    cam.frame = nextBuf;
    cam.frameAt = now;
    cam.lastVideoAt = now;
    cam.frameNew = true;
    cam.lastFrame = nextBuf;
    cam.lastSeen = formatLocalHm(new Date(now));
  }
}

/**
 * Selects the YUV420p frame buffer to feed to the camera's encoder (live video with optional
 * corner card, clean snapshot fallback, waking card, busy card, or asleep card).
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {{ frame: Uint8Array, isLive: boolean }}
 */
function selectEncoderFrame(cam, now) {
  const hasFreshFrame = Boolean(cam.frame && now - cam.frameAt < 2000);
  const isLive = Boolean(cam.active && (hasFreshFrame || (cam.gotVideo && Buffer.isBuffer(cam.lastFrame))));

  if (isLive) {
    const rawLiveFrame = hasFreshFrame ? cam.frame : cam.lastFrame;
    const liveFrame = rawLiveFrame ? renderLiveFrameWithCard(cam, rawLiveFrame) : rawLiveFrame;
    return {frame: liveFrame, isLive: true};
  }
  if (cam.suppressLiveCard && Buffer.isBuffer(cam.lastFrame)) {
    return {frame: cam.lastFrame, isLive: false};
  }
  if (cam.active) {
    return {frame: cam.waking, isLive: false};
  }
  if (now < want(cam)) {
    return {frame: cam.busy, isLive: false};
  }
  return {frame: cam.asleep, isLive: false};
}

/**
 * Determines whether a frame should be written to the FFmpeg encoder stdin on the current tick.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {boolean} isLive - Whether the camera is currently streaming live video.
 * @param {boolean} stateChanged - Whether the selected frame buffer changed since last write.
 * @param {boolean} inBurst - Whether the camera is in a keyframe burst window.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function shouldWriteEncoderFrame(cam, isLive, stateChanged, inBurst, now) {
  const elapsedMs = now - cam.lastWrite;
  if (isLive) {
    return Boolean(cam.frameNew || elapsedMs >= 500);
  }
  return Boolean(stateChanged || inBurst || elapsedMs >= 1000 / IDLE_FPS);
}

/**
 * Pushes the appropriate video frame to a camera's persistent FFmpeg encoder stdin.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function pushFrameToEncoder(cam, now = Date.now()) {
  const enc = cam.enc;
  if (!enc || !enc.stdin || !enc.stdin.writable) {
    return;
  }
  if (enc.stdin.writableNeedDrain) {
    if (now - cam.lastWrite > 10000) {
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
    cam.burstUntil = Math.max(cam.burstUntil || 0, now + 1200);
  }
  const inBurst = now < (cam.burstUntil || 0);

  if (shouldWriteEncoderFrame(cam, isLive, stateChanged, inBurst, now)) {
    enc.stdin.write(frame);
    cam.lastWrite = now;
    cam.lastSent = frame;
    cam.frameNew = false;
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
        '18',
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
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
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
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
        '-g',
        gop,
      ];
    case 'v4l2m2m':
      return ['-c:v', 'h264_v4l2m2m', '-pix_fmt', 'yuv420p', '-b:v', '3000k', '-g', gop];
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
        '19',
        '-maxrate',
        '3500k',
        '-bufsize',
        '5000k',
        '-g',
        gop,
      ];
  }
}

/**
 * Builds the full FFmpeg CLI argument list for a camera's persistent RTSP encoder.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {string} hwMode - Hardware acceleration mode ('vaapi', 'qsv', 'nvenc', 'v4l2m2m', or '').
 * @returns {string[]}
 */
function buildEncoderArgs(cam, hwMode) {
  const gop = String(Math.max(4, LIVE_FPS));
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
    args.push('-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '32k');
  }
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', cfg.rtsp_publish.replace('{name}', cam.name));
  return args;
}

/**
 * Spawns the persistent FFmpeg encoder process for a camera.
 *
 * @param {Record<string, *>} cam - Camera state object.
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

  cam.enc = enc;
  cam.lastSent = null;
  cam.lastWrite = Date.now();
  cam.burstUntil = Date.now() + 1500;

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
    tail = (tail + d).slice(-500);
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
        Date.now() - spawnAt < 5000 &&
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
      }, 1000);
      return;
    }

    log.error(cam, 'encoder exited (code=' + code + ') ' + errSummary + ' - restarting in 3 s');
    if (Date.now() - spawnAt > 10000 && onEncoderDropCallback) {
      onEncoderDropCallback();
    }
    setTimeout(() => {
      if (!cam.enc && !isShuttingDownFn()) {
        startEncoder(cam);
      }
    }, 3000);
  });

  const codecLabel = hwMode ? 'h264_' + hwMode : 'libx264';
  log.info(cam, 'encoder (' + codecLabel + ') publishing to go2rtc');
}

/**
 * Starts the periodic video frame ticker (at LIVE_FPS) and 100ms PCM audio ticker
 * across all configured cameras.
 *
 * @param {Array<Record<string, *>>} cams - Array of Camera instances.
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
        let out = SILENCE;
        if (cam.pcmLen >= AUDIO_CHUNK) {
          const all = cam.pcm.length === 1 ? cam.pcm[0] : Buffer.concat(cam.pcm);
          out = all.subarray(0, AUDIO_CHUNK);
          const rest = all.subarray(AUDIO_CHUNK);
          cam.pcm = rest.length ? [rest] : [];
          cam.pcmLen = rest.length;
        }
        enc.stdio[3].write(out);
      }
    }, AUDIO_TICK);
  }
}

module.exports = {
  configureEncoderHooks,
  advanceDownloadPlaybackFrame,
  selectEncoderFrame,
  shouldWriteEncoderFrame,
  pushFrameToEncoder,
  buildVideoCodecArgs,
  buildEncoderArgs,
  startEncoder,
  startMediaTickers,
};
