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
 * Pushes the appropriate video frame (live decoded video, waking card, busy card, or asleep card)
 * to a camera's persistent FFmpeg encoder stdin immediately when a state change or new decoded
 * frame arrives, or on the periodic frame tick.
 *
 * @param {Record<string, *>} cam - Camera state object.
 * @param {number} [now=Date.now()] - Current epoch timestamp in milliseconds.
 */
function pushFrameToEncoder(cam, now = Date.now()) {
  const enc = cam.enc;
  if (!enc || !enc.stdin || !enc.stdin.writable) return;
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

  if (
      cam.active &&
      cam.activeMode === 'download' &&
      cam.downloadFrames.length > 0 &&
      now - cam.lastWrite >= Math.floor(1000 / LIVE_FPS) - 4
  ) {
    const nextBuf = cam.downloadFrames.shift();
    cam.frame = nextBuf;
    cam.frameAt = now;
    cam.lastVideoAt = now;
    cam.frameNew = true;
    cam.lastFrame = nextBuf;
    cam.lastSeen = formatLocalHm(new Date(now));
  }

  const hasFreshFrame = Boolean(cam.frame && now - cam.frameAt < 2000);
  const live = cam.active && (hasFreshFrame || (cam.gotVideo && Buffer.isBuffer(cam.lastFrame)));
  const rawLiveFrame = hasFreshFrame ? cam.frame : cam.lastFrame;
  const liveFrame =
      live && rawLiveFrame ? renderLiveFrameWithCard(cam, rawLiveFrame) : rawLiveFrame;
  const frame = live
      ? liveFrame
      : cam.suppressLiveCard && Buffer.isBuffer(cam.lastFrame)
          ? cam.lastFrame
          : cam.active
              ? cam.waking
              : now < want(cam)
                  ? cam.busy
                  : cam.asleep;
  const stateChanged = frame !== cam.lastSent;
  if (stateChanged) {
    cam.burstUntil = Math.max(cam.burstUntil || 0, now + 1200);
  }
  const inBurst = now < (cam.burstUntil || 0);

  if (
      live
          ? cam.frameNew || now - cam.lastWrite >= 500
          : stateChanged || inBurst || now - cam.lastWrite >= 1000 / IDLE_FPS
  ) {
    enc.stdin.write(frame);
    cam.lastWrite = now;
    cam.lastSent = frame;
    cam.frameNew = false;
  }
}

/**
 * Spawns the persistent FFmpeg encoder process for a camera.
 * Reads raw YUV420p video frames from stdin (pipe:0) and s16le PCM audio from fd 3 (pipe:3),
 * publishing a continuous H.264 + AAC RTSP stream to go2rtc.
 *
 * @param {Record<string, *>} cam - Camera state object.
 */
function startEncoder(cam) {
  if (isShuttingDownFn() || cam.enc) return;

  const hwMode = cam.useHwaccel ? ACTIVE_HWACCEL : '';
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

  args.push('-fps_mode', 'passthrough');

  if (hwMode === 'vaapi') {
    args.push(
        '-vf',
        'format=nv12,hwupload',
        '-c:v',
        'h264_vaapi',
        '-bf',
        '0',
        '-qp',
        '18',
        '-g',
        gop
    );
  } else if (hwMode === 'qsv') {
    args.push(
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
        gop
    );
  } else if (hwMode === 'nvenc') {
    args.push(
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
        gop
    );
  } else if (hwMode === 'v4l2m2m') {
    args.push('-c:v', 'h264_v4l2m2m', '-pix_fmt', 'yuv420p', '-b:v', '3000k', '-g', gop);
  } else {
    args.push(
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
        gop
    );
  }

  if (AUDIO) {
    args.push('-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '32k');
  }
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', cfg.rtsp_publish.replace('{name}', cam.name));

  const spawnAt = Date.now();
  const enc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.enc = enc;
  cam.lastSent = null;
  cam.lastWrite = Date.now();
  cam.burstUntil = Date.now() + 1500;

  enc.on('error', (e) => log.error(cam, 'encoder process error: ' + e.message));
  enc.stdin.on('error', () => {
  });
  enc.stdin.on('drain', () => {
    if (cam.frameNew) pushFrameToEncoder(cam);
  });
  if (AUDIO && enc.stdio[3]) enc.stdio[3].on('error', () => {
  });

  let tail = '';
  enc.stderr.on('data', (d) => {
    tail = (tail + d).slice(-500);
  });
  enc.on('exit', (code) => {
    if (cam.enc === enc) cam.enc = null;
    if (isShuttingDownFn()) return;
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
        if (!cam.enc && !isShuttingDownFn()) startEncoder(cam);
      }, 1000);
      return;
    }

    log.error(cam, 'encoder exited (code=' + code + ') ' + errSummary + ' - restarting in 3 s');
    if (Date.now() - spawnAt > 10000 && onEncoderDropCallback) {
      onEncoderDropCallback();
    }
    setTimeout(() => {
      if (!cam.enc && !isShuttingDownFn()) startEncoder(cam);
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
        if (!enc || !enc.stdio[3] || !enc.stdio[3].writable || enc.stdio[3].writableNeedDrain) continue;
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
  pushFrameToEncoder,
  startEncoder,
  startMediaTickers,
};
