// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 obatiuk
 * SPDX-License-Identifier: MIT
 *
 * Per-session FFmpeg P2P Annex-B and HomeBase RTSP pull decoders,
 * keyframe detection, and raw A/V packet ingestion.
 */
'use strict';

const {spawn} = require('node:child_process');
const {
  W,
  H,
  FRAME,
  LIVE_FPS,
  AUDIO,
  RATE,
  STDERR_TAIL_MAX_CHARS,
  PROCESS_SIGNALS,
  STREAM_MODES,
  stripRtspUrlFragment,
} = require('../config');
const {log, formatLocalHm} = require('../logger');
const {Camera} = require('../domain/camera');
const {pushFrameToEncoder, FfmpegArgsBuilder} = require('./encoder');

/** @typedef {import("../domain/camera").Camera} CameraInstance */

const P2P_VIDEO_PROBESIZE_BYTES = '32768';
const P2P_AUDIO_PROBESIZE_BYTES = '1024';
const P2P_PIPE_THREAD_QUEUE_SIZE = '16';
const RTSP_PROBESIZE_BYTES = '524288';
const RTSP_ANALYZEDURATION_US = '1000000';
const RTSP_THREAD_QUEUE_SIZE = '32';
const DECODER_VIDEO_THREADS = '2';
const RTSP_SOCKET_TIMEOUT_US = '5000000';
const RTSP_RETRY_DELAY_MS = 750;
const RTSP_MAX_SPAWN_BACKOFF_MS = 15000;
const P2P_SPAWN_RETRY_DELAY_MS = 1000;
const P2P_MAX_SPAWN_BACKOFF_MS = 15000;
const DECODER_SIGKILL_DELAY_MS = 2000;
const STARTUP_PROBE_CAPTURE_MS = 2000;
const MAX_DOWNLOAD_BUFFER_SECS = 120;
const KEY_PACKET_SCAN_BYTES = 4096;
const HEVC_NAL_VPS = 32;
const HEVC_NAL_SPS = 33;
const H264_NAL_SPS = 7;
const HEVC_CODEC_REGEX = /265|hevc/i;

let stopCameraCallback = null;
let rtspDropCallback = null;
/** @type {typeof spawn} */
let decoderSpawnFn = spawn;
/**
 * @type {WeakMap<Camera, {
 *   p2pFailures: number,
 *   p2pRetryAfterAt: number,
 *   p2pSessionId: number,
 *   rtspSpawnFailures: number,
 *   rtspSessionId: number
 * }>}
 */
const decoderSpawnStateByCam = new WeakMap();

/**
 * Registers optional test/runtime hooks for the FFmpeg decoder manager.
 *
 * @param {{ spawn?: typeof spawn | null }} [hooks={}] - Decoder hooks.
 */
function configureDecoderHooks(hooks = {}) {
  if (hooks.spawn === null) {
    decoderSpawnFn = spawn;
  } else if (typeof hooks.spawn === 'function') {
    decoderSpawnFn = hooks.spawn;
  }
}

/**
 * Returns or initializes per-camera decoder spawn failure backoff tracking.
 *
 * @param {Camera} cam - Camera state object.
 * @returns {{
 *   p2pFailures: number,
 *   p2pRetryAfterAt: number,
 *   p2pSessionId: number,
 *   rtspSpawnFailures: number,
 *   rtspSessionId: number
 * }}
 */
function getDecoderSpawnState(cam) {
  let state = decoderSpawnStateByCam.get(cam);
  if (!state) {
    state = {
      p2pFailures: 0,
      p2pRetryAfterAt: 0,
      p2pSessionId: -1,
      rtspSpawnFailures: 0,
      rtspSessionId: -1,
    };
    decoderSpawnStateByCam.set(cam, state);
  }
  return state;
}

/**
 * Records a P2P/backfill FFmpeg spawn failure and sets the exponential retry cooldown timestamp.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} sessionId - Session ID in which the spawn failed.
 * @returns {number} Backoff delay in milliseconds before the next P2P decoder spawn attempt.
 */
function recordP2pDecoderSpawnFailure(cam, sessionId) {
  const state = getDecoderSpawnState(cam);
  if (state.p2pSessionId !== sessionId) {
    state.p2pSessionId = sessionId;
    state.p2pFailures = 0;
  }
  const delayMs = Math.min(P2P_MAX_SPAWN_BACKOFF_MS, P2P_SPAWN_RETRY_DELAY_MS * 2 ** state.p2pFailures);
  state.p2pFailures++;
  state.p2pRetryAfterAt = Date.now() + delayMs;
  return delayMs;
}

/**
 * Returns true if a P2P/backfill session is inside a post-spawn-error backoff window.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @returns {boolean}
 */
function isP2pDecoderSpawnBackedOff(cam, now) {
  const state = decoderSpawnStateByCam.get(cam);
  if (!state || state.p2pSessionId !== cam.getSessionId()) {
    return false;
  }
  return now < state.p2pRetryAfterAt;
}

/**
 * Computes the RTSP decoder retry delay: exponential backoff on consecutive spawn errors in the
 * same session, or standard RTSP_RETRY_DELAY_MS when FFmpeg ran and exited normally.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} sessionId - Session ID of the RTSP stream.
 * @param {boolean} isSpawnError - True when FFmpeg failed to spawn ('error' event or throw).
 * @returns {number} Retry delay in milliseconds.
 */
function computeRtspDecoderRetryDelay(cam, sessionId, isSpawnError) {
  const state = getDecoderSpawnState(cam);
  if (state.rtspSessionId !== sessionId || !isSpawnError) {
    state.rtspSessionId = sessionId;
    state.rtspSpawnFailures = 0;
    if (!isSpawnError) {
      return RTSP_RETRY_DELAY_MS;
    }
  }
  const delayMs = Math.min(RTSP_MAX_SPAWN_BACKOFF_MS, RTSP_RETRY_DELAY_MS * 2 ** state.rtspSpawnFailures);
  state.rtspSpawnFailures++;
  return delayMs;
}

/**
 * Registers the callback used to stop a camera session once a 2-second startup snapshot probe completes.
 *
 * @param {(cam: Camera, why: string, preemptedByViewer?: boolean, initiator?: string) => void} fn - Stop handler.
 */
function setDecoderStopHandler(fn) {
  stopCameraCallback = fn;
}

/**
 * Registers the callback invoked immediately when an active RTSP stream drops mid-session.
 *
 * @param {(cam: Camera, code: number|null, lastLine: string) => void} fn - RTSP drop handler.
 */
function setRtspDropHandler(fn) {
  rtspDropCallback = fn;
}

/**
 * Builds the FFmpeg video scale filter string for a camera (preserving aspect ratio with dark
 * padding when preserveAspect is true, or scaling to WxH directly).
 *
 * @param {boolean} preserveAspect - Whether to preserve native aspect ratio.
 * @returns {string}
 */
function buildScaleFilter(preserveAspect) {
  if (!preserveAspect) {
    return 'scale=' + W + ':' + H + ':flags=lanczos';
  }
  return (
    'scale=' +
    W +
    ':' +
    H +
    ':flags=lanczos:force_original_aspect_ratio=decrease,pad=' +
    W +
    ':' +
    H +
    ':(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c'
  );
}

/**
 * Builds the FFmpeg CLI arguments for a low-latency P2P Annex-B stream decoder.
 *
 * @param {string} vfmt - Input video format ('hevc' or 'h264').
 * @param {string} scaleFilter - FFmpeg -vf scale filter string.
 * @returns {readonly string[]}
 */
function buildP2pDecoderArgs(vfmt, scaleFilter) {
  const builder = new FfmpegArgsBuilder()
    .hideBanner()
    .withSingleFilterThreads()
    .withLowLatencyFlags()
    .append(
      '-probesize',
      P2P_VIDEO_PROBESIZE_BYTES,
      '-analyzeduration',
      '0',
      '-thread_queue_size',
      P2P_PIPE_THREAD_QUEUE_SIZE,
      '-threads',
      DECODER_VIDEO_THREADS,
      '-f',
      vfmt,
      '-i',
      'pipe:0'
    );

  if (AUDIO) {
    builder.append(
      '-probesize',
      P2P_AUDIO_PROBESIZE_BYTES,
      '-analyzeduration',
      '0',
      '-thread_queue_size',
      P2P_PIPE_THREAD_QUEUE_SIZE,
      '-f',
      'aac',
      '-i',
      'pipe:3'
    );
  }

  builder.append('-map', '0:v', '-vf', scaleFilter).withRawYuvOutput().withS16leAudioOutput(AUDIO, '1:a', RATE);
  return builder.build();
}

/**
 * Prepends a non-duplicating Bresenham VFR framerate cap (`<= LIVE_FPS`) ahead of the RTSP
 * decoder scale filter so 20/25/30 fps standalone or Eufy Baby RTSP streams are decimated to
 * LIVE_FPS before Lanczos scaling and pipe:1 rawvideo output, while <= LIVE_FPS streams (including
 * 10 fps IR night vision) pass through untouched with zero Frame 0 lookahead delay.
 *
 * @param {string} scaleFilter - FFmpeg -vf scale filter string.
 * @returns {string}
 */
function buildRtspVideoFilter(scaleFilter) {
  return (
    "select='if(isnan(t),1,if(not(ld(1))+lt(t,ld(0)-2),st(1,1)*0+st(0,t+1/" +
    LIVE_FPS +
    ')+1,if(gte(t,ld(0)-0.004),st(0,max(t-0.5/' +
    LIVE_FPS +
    ',ld(0))+1/' +
    LIVE_FPS +
    ")*0+1,0)))'," +
    scaleFilter
  );
}

/**
 * Builds the FFmpeg CLI arguments for a low-latency HomeBase or direct RTSP pull decoder.
 *
 * @param {string} rtspUrl - HomeBase or direct RTSP stream URL.
 * @param {string} scaleFilter - FFmpeg -vf scale filter string.
 * @returns {readonly string[]}
 */
function buildRtspDecoderArgs(rtspUrl, scaleFilter) {
  return new FfmpegArgsBuilder()
    .hideBanner()
    .withSingleFilterThreads()
    .withLowLatencyFlags()
    .append(
      '-rtsp_transport',
      'tcp',
      '-timeout',
      RTSP_SOCKET_TIMEOUT_US,
      '-probesize',
      RTSP_PROBESIZE_BYTES,
      '-analyzeduration',
      RTSP_ANALYZEDURATION_US,
      '-thread_queue_size',
      RTSP_THREAD_QUEUE_SIZE,
      '-threads',
      DECODER_VIDEO_THREADS,
      '-i',
      stripRtspUrlFragment(rtspUrl),
      '-map',
      '0:v:0',
      '-vf',
      buildRtspVideoFilter(scaleFilter)
    )
    .withRawYuvOutput()
    .withS16leAudioOutput(AUDIO, '0:a:0?', RATE)
    .build();
}

/**
 * Appends a decoded s16le PCM audio chunk to a camera's audio queue, dropping oldest chunks
 * if the buffer exceeds 1 second of live audio (or MAX_DOWNLOAD_BUFFER_SECS during clip download).
 *
 * @param {Camera} cam - Camera state object.
 * @param {Uint8Array} chunk - Raw s16le PCM buffer.
 */
function appendAudioPcmChunk(cam, chunk) {
  cam.appendAudioChunk(chunk, RATE * 2, RATE * 2 * MAX_DOWNLOAD_BUFFER_SECS);
}

/**
 * Updates the camera live frame buffers, lastSeen timestamp, and pushes the frame to the encoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Uint8Array} liveFrame - Frame buffer assigned to cam.frame.
 * @param {Uint8Array} snapshotCopy - Independent Buffer copy assigned to cam.lastFrame.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function commitDecodedFrame(cam, liveFrame, snapshotCopy, now) {
  cam.recordDecodedFrame(liveFrame, snapshotCopy, now, formatLocalHm(new Date(now)));
  pushFrameToEncoder(cam, now);
}

/**
 * Processes a complete decoded YUV420p frame from a P2P livestream or clip download decoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Uint8Array} rawBuf - Raw frame buffer of length FRAME.
 * @param {number} now - Current epoch timestamp in milliseconds.
 */
function handleDecodedP2pFrame(cam, rawBuf, now) {
  const spawnState = decoderSpawnStateByCam.get(cam);
  if (spawnState) {
    spawnState.p2pFailures = 0;
    spawnState.p2pRetryAfterAt = 0;
  }
  if (cam.isBackfillPlayback()) {
    const frameCopy = cam.acquireDownloadFrameBuffer(rawBuf);
    if (!cam.bufferDownloadFrame(frameCopy, LIVE_FPS * MAX_DOWNLOAD_BUFFER_SECS)) {
      commitDecodedFrame(cam, frameCopy, frameCopy, now);
    }
    return;
  }

  if (cam.bufferLiveFrame(rawBuf, now, formatLocalHm(new Date(now)))) {
    pushFrameToEncoder(cam, now);
  } else {
    const slot = cam.acquireNextLiveFrameSlot(rawBuf);
    commitDecodedFrame(cam, slot, slot, now);
  }

  if (cam.completeStartupProbeIfReady(now, STARTUP_PROBE_CAPTURE_MS) && stopCameraCallback) {
    stopCameraCallback(cam, 'startup snapshot captured after 2s stable video', false, 'bridge-startup-probe');
  }
}

/**
 * Processes a complete decoded YUV420p frame from a HomeBase RTSP pull decoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Uint8Array} rawBuf - Raw frame buffer of length FRAME.
 * @param {number} now - Current epoch timestamp in milliseconds.
 * @param {number} mySession - Session identifier associated with the decoder.
 */
function handleDecodedRtspFrame(cam, rawBuf, now, mySession) {
  const spawnState = decoderSpawnStateByCam.get(cam);
  if (spawnState) {
    spawnState.rtspSpawnFailures = 0;
  }
  const {isFirstVideo, isRewakeResume, elapsedSec} = cam.markRtspFrameReceived(now);
  if (isFirstVideo) {
    log.info(cam, 'first RTSP video ' + elapsedSec + ' s after wake (session=' + mySession + ')');
  } else if (isRewakeResume) {
    log.debug(cam, 'RTSP video resumed ' + elapsedSec + ' s after mid-session re-wake (session=' + mySession + ')');
  }
  if (cam.bufferLiveFrame(rawBuf, now, formatLocalHm(new Date(now)))) {
    pushFrameToEncoder(cam, now);
  } else {
    const slot = cam.acquireNextLiveFrameSlot(rawBuf);
    commitDecodedFrame(cam, slot, slot, now);
  }
}

const ignorePipeWriteError = () => {};

/**
 * Attaches stdout rawvideo frame chunking, audio PCM pipe ingestion, and stderr tail
 * buffering to a spawned FFmpeg decoder process.
 *
 * @param {Camera} cam - Camera state object.
 * @param {import("child_process").ChildProcess} decoderProcess - Spawned FFmpeg decoder.
 * @param {number} sessionId - Session identifier.
 * @param {(buf: Uint8Array, now: number) => void} onCompleteFrame - Callback invoked for each complete YUV420p frame.
 * @returns {() => string} Getter returning the last line of stderr output.
 */
function attachDecoderStreams(cam, decoderProcess, sessionId, onCompleteFrame) {
  const frameScratchBuffer = cam.acquireDecoderReadBuffer();
  let bufferedBytes = 0;
  decoderProcess.stdout.on('data', (rawChunk) => {
    if (!cam.isActiveDecoder(decoderProcess, sessionId)) {
      bufferedBytes = 0;
      return;
    }
    let readCursor = 0;
    const chunkByteLen = rawChunk.length;
    while (readCursor < chunkByteLen) {
      const remainingFrameBytes = FRAME - bufferedBytes;
      const availableChunkBytes = chunkByteLen - readCursor;
      const copyByteCount = remainingFrameBytes < availableChunkBytes ? remainingFrameBytes : availableChunkBytes;
      rawChunk.copy(frameScratchBuffer, bufferedBytes, readCursor, readCursor + copyByteCount);
      bufferedBytes += copyByteCount;
      readCursor += copyByteCount;
      if (bufferedBytes >= FRAME) {
        if (cam.isActiveDecoder(decoderProcess, sessionId)) {
          onCompleteFrame(frameScratchBuffer, Date.now());
        }
        bufferedBytes = 0;
      }
    }
  });

  if (AUDIO && decoderProcess.stdio[4]) {
    decoderProcess.stdio[4].on('data', (audioChunk) => {
      if (cam.isActiveDecoder(decoderProcess, sessionId)) {
        appendAudioPcmChunk(cam, audioChunk);
      }
    });
  }

  const stderrCollector = FfmpegArgsBuilder.attachStderrTailCollector(decoderProcess, STDERR_TAIL_MAX_CHARS);
  return () => stderrCollector.getLastLine();
}

/**
 * Handles FFmpeg P2P/backfill decoder process exit without discarding unread tail frames
 * that are still buffered in a paused stdout stream when the child process exits on EOF.
 *
 * @param {Camera} cam - Camera state object.
 * @param {*} dec - Exiting FFmpeg decoder process.
 * @param {number} mySession - Session identifier.
 * @param {number|null} code - Process exit code.
 * @param {() => string} [getLastStderrLine=() => ''] - Callback returning last stderr line.
 */
function handleP2pDecoderExit(cam, dec, mySession, code, getLastStderrLine = () => '') {
  if (cam.shouldDeferDecoderDetachOnExit(dec)) {
    const detachWhenStdoutCloses = () => {
      cam.detachDecoderIfMatch(dec, false);
    };
    if (typeof dec.stdout.once === 'function') {
      dec.stdout.once('close', detachWhenStdoutCloses);
    } else if (typeof dec.stdout.on === 'function') {
      dec.stdout.on('close', detachWhenStdoutCloses);
    }
    if (cam.shouldResumePausedDecoderOnExit()) {
      cam.resumeDecoderStdout();
    }
    return;
  }
  if (cam.dec === dec) {
    cam.resumeDecoderStdout();
  }
  if (cam.detachDecoderIfMatch(dec, false)) {
    if (cam.shouldLogUnexpectedDecoderExit(mySession, code)) {
      log.warn(
        cam,
        'decoder exited while stream active (initiator=ffmpeg-decoder, code=' +
          code +
          ', session=' +
          mySession +
          '): ' +
          getLastStderrLine()
      );
    }
  }
}

/**
 * Schedules a deferred P2P/backfill decoder spawn retry when queued packets remain on the active session.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} mySession - Session identifier.
 * @param {number} delayMs - Backoff delay in milliseconds.
 */
function scheduleP2pDecoderSpawnRetry(cam, mySession, delayMs) {
  const timer = setTimeout(() => {
    if (!cam.hasDecoderProcess() && cam.isCurrentSession(mySession) && cam.pendingVideoPackets.length > 0) {
      startDecoder(cam);
    }
  }, delayMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

/**
 * Spawns a low-latency per-session FFmpeg decoder for an active camera livestream.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} [codec=cam.getVideoCodec()] - Video codec name reported by eufy-security-ws ('H264' or 'H265').
 */
function startDecoder(cam, codec = cam.getVideoCodec()) {
  const mySession = cam.getSessionId();
  const vfmt = HEVC_CODEC_REGEX.test(codec) ? 'hevc' : 'h264';
  const scaleFilter = buildScaleFilter(cam.getPreserveAspect());
  const args = buildP2pDecoderArgs(vfmt, scaleFilter);

  /** @type {import("child_process").ChildProcess} */
  let decoderProcess;
  try {
    decoderProcess = decoderSpawnFn('ffmpeg', /** @type {string[]} */ (args), {
      stdio: ['pipe', 'pipe', 'pipe', AUDIO ? 'pipe' : 'ignore', AUDIO ? 'pipe' : 'ignore'],
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log.error(cam, 'decoder process error: ' + msg);
    if (cam.isCurrentSession(mySession)) {
      const delayMs = recordP2pDecoderSpawnFailure(cam, mySession);
      scheduleP2pDecoderSpawnRetry(cam, mySession, delayMs);
    }
    return;
  }
  cam.attachDecoder(decoderProcess);
  log.debug(cam, 'started FFmpeg decoder (codec=' + vfmt + ', session=' + mySession + ')');

  let settled = false;
  decoderProcess.on('error', (e) => {
    log.error(cam, 'decoder process error: ' + e.message);
    if (settled) {
      return;
    }
    settled = true;
    if (cam.dec === decoderProcess) {
      cam.resumeDecoderStdout();
    }
    if (cam.detachDecoderIfMatch(decoderProcess, false) && cam.isCurrentSession(mySession)) {
      const delayMs = recordP2pDecoderSpawnFailure(cam, mySession);
      scheduleP2pDecoderSpawnRetry(cam, mySession, delayMs);
    }
  });
  if (decoderProcess.stdin) {
    decoderProcess.stdin.on('error', ignorePipeWriteError);
    decoderProcess.stdin.on('drain', () => cam.drainPendingDecoderInput(AUDIO, true));
  }
  if (AUDIO && decoderProcess.stdio && decoderProcess.stdio[3]) {
    decoderProcess.stdio[3].on('error', ignorePipeWriteError);
    decoderProcess.stdio[3].on('drain', () => cam.drainPendingDecoderInput(AUDIO, true));
  }

  const getLastStderrLine = attachDecoderStreams(cam, decoderProcess, mySession, (frameBuf, now) => {
    handleDecodedP2pFrame(cam, frameBuf, now);
  });

  decoderProcess.on('exit', (exitCode) => {
    if (settled) {
      return;
    }
    settled = true;
    handleP2pDecoderExit(cam, decoderProcess, mySession, exitCode, getLastStderrLine);
  });
}

/**
 * Schedules an RTSP decoder retry timer for a specific session ID.
 *
 * @param {Camera} cam - Camera state object.
 * @param {number} mySession - Session identifier.
 * @param {number} delayMs - Retry delay in milliseconds.
 */
function scheduleRtspRetryForSession(cam, mySession, delayMs) {
  cam.scheduleRtspDecoderRetry(delayMs, () => {
    if (cam.canSpawnRtspDecoder(mySession)) {
      startRtspDecoder(cam);
    }
  });
}

/**
 * Spawns a low-latency FFmpeg RTSP client decoder that pulls directly from a camera's HomeBase
 * RTSP URL without using the shared P2P livestream slot.
 *
 * @param {Camera} cam - Camera state object.
 */
function startRtspDecoder(cam) {
  cam.clearRtspRetryTimer();
  const mySession = cam.getSessionId();
  const rtspUrl = cam.getRtspUrl();
  const scaleFilter = buildScaleFilter(cam.getPreserveAspect());
  const args = buildRtspDecoderArgs(rtspUrl, scaleFilter);

  /** @type {import("child_process").ChildProcess} */
  let rtspProcess;
  try {
    rtspProcess = decoderSpawnFn('ffmpeg', /** @type {string[]} */ (args), {
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', AUDIO ? 'pipe' : 'ignore'],
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log.error(cam, 'RTSP decoder process error: ' + msg);
    if (cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
      const delayMs = computeRtspDecoderRetryDelay(cam, mySession, true);
      scheduleRtspRetryForSession(cam, mySession, delayMs);
    }
    return;
  }
  cam.attachDecoder(rtspProcess, Date.now());
  log.debug(cam, 'started FFmpeg RTSP pull decoder (session=' + mySession + ')');

  const getLastStderrLine = attachDecoderStreams(cam, rtspProcess, mySession, (frameBuf, now) => {
    handleDecodedRtspFrame(cam, frameBuf, now, mySession);
  });

  let settled = false;
  rtspProcess.on('error', (e) => {
    log.error(cam, 'RTSP decoder process error: ' + e.message);
    if (settled) {
      return;
    }
    settled = true;
    if (cam.detachDecoderIfMatch(rtspProcess, true) && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
      const delayMs = computeRtspDecoderRetryDelay(cam, mySession, true);
      scheduleRtspRetryForSession(cam, mySession, delayMs);
    }
  });

  rtspProcess.on('exit', (exitCode) => {
    if (settled) {
      return;
    }
    settled = true;
    if (cam.detachDecoderIfMatch(rtspProcess, true) && cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
      const lastLine = getLastStderrLine();
      if ((cam.isEstablishedRtspStream() || cam.isRtspDirect()) && rtspDropCallback) {
        rtspDropCallback(cam, exitCode, lastLine);
        return;
      }
      const delayMs = computeRtspDecoderRetryDelay(cam, mySession, false);
      log.debug(
        cam,
        'RTSP decoder exited while camera waking/streaming (code=' +
          exitCode +
          ', session=' +
          mySession +
          '): ' +
          lastLine +
          ' - retrying in ' +
          delayMs +
          'ms'
      );
      scheduleRtspRetryForSession(cam, mySession, delayMs);
    }
  });
}

/**
 * Closes the active FFmpeg decoder's video and audio input pipes on EOF (such as when a
 * HomeBase clip download completes) so FFmpeg flushes any buffered frames in its H.265/H.264
 * reorder buffer to stdout before exiting cleanly.
 *
 * @param {Camera} cam - Camera state object.
 */
function flushDecoderInput(cam) {
  if (!cam.hasDecoderProcess()) {
    return;
  }
  cam.markDecoderInputEnded();
}

/**
 * Stops a camera's active FFmpeg decoder process and clears its temporary A/V buffers.
 *
 * @param {Camera} targetCam - Camera state object.
 */
function stopDecoder(targetCam) {
  const activeDec = targetCam.detachDecoder();
  if (!activeDec) {
    return;
  }
  try {
    if (activeDec.stdin) {
      activeDec.stdin.end();
    }
  } catch (err) {
    // Ignore errors when closing decoder stdin.
  }
  if (!Camera.canSignalProcess(activeDec)) {
    return;
  }
  try {
    activeDec.kill(PROCESS_SIGNALS.SIGTERM);
  } catch (err) {
    // Ignore errors when sending SIGTERM.
  }
  const killTimer = setTimeout(() => {
    if (!Camera.canSignalProcess(activeDec)) {
      return;
    }
    try {
      activeDec.kill(PROCESS_SIGNALS.SIGKILL);
    } catch (err) {
      // Ignore errors if decoder already exited.
    }
  }, DECODER_SIGKILL_DELAY_MS);
  if (killTimer && typeof killTimer.unref === 'function') {
    killTimer.unref();
  }
}

/**
 * Converts a serialized Buffer payload from eufy-security-ws into a Node.js Buffer.
 *
 * @param {Record<string, *>} eventPayload - Event object containing buffer.
 * @returns {Uint8Array}
 */
function extractPacketBytes(eventPayload) {
  const rawBuffer = eventPayload && eventPayload.buffer;
  if (!rawBuffer) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(rawBuffer)) {
    return rawBuffer;
  }
  const byteItems = Array.isArray(rawBuffer.data) ? rawBuffer.data : rawBuffer;
  return Buffer.from(byteItems);
}

/**
 * Returns the byte index immediately following an Annex-B start code (00 00 01 or 00 00 00 01)
 * at position 'scanOffset', or -1 if no start code begins at 'scanOffset'.
 *
 * @param {Uint8Array} packetBuf - Raw video packet buffer.
 * @param {number} scanOffset - Current scan index.
 * @returns {number}
 */
function findNalHeaderOffset(packetBuf, scanOffset) {
  if (packetBuf[scanOffset] !== 0 || packetBuf[scanOffset + 1] !== 0) {
    return -1;
  }
  const thirdByte = packetBuf[scanOffset + 2];
  if (thirdByte === 1) {
    return scanOffset + 3;
  }
  if (thirdByte === 0 && packetBuf[scanOffset + 3] === 1) {
    return scanOffset + 4;
  }
  return -1;
}

/**
 * Inspects an Annex-B video packet to determine whether it contains codec parameter sets
 * (HEVC VPS=32 / SPS=33, or H.264 SPS=7) required for FFmpeg to initialize a decoder cleanly.
 *
 * @param {Uint8Array} packetBuf - Raw video packet buffer.
 * @param {string} codecName - Video codec string ('H264' or 'H265').
 * @returns {boolean} True if the packet starts with a keyframe parameter set.
 */
function isKeyPacket(packetBuf, codecName) {
  const isHevcCodec = HEVC_CODEC_REGEX.test(codecName);
  const maxScanOffset = Math.min(packetBuf.length - 4, KEY_PACKET_SCAN_BYTES);
  for (let pos = 0; pos < maxScanOffset; pos++) {
    const headerOffset = findNalHeaderOffset(packetBuf, pos);
    if (headerOffset < 0 || headerOffset >= packetBuf.length) {
      continue;
    }
    const headerByte = packetBuf[headerOffset];
    const unitType = isHevcCodec ? (headerByte >>> 1) & 0x3f : headerByte & 0x1f;
    const matchesParameterSet = isHevcCodec
      ? unitType === HEVC_NAL_VPS || unitType === HEVC_NAL_SPS
      : unitType === H264_NAL_SPS;
    if (matchesParameterSet) {
      return true;
    }
    pos = headerOffset;
  }
  return false;
}

/**
 * Handles an incoming raw video packet from eufy-security-ws.
 *
 * @param {Camera} targetCam - Camera state object.
 * @param {Record<string, *>} videoEvent - Livestream video data event.
 */
function onVideo(targetCam, videoEvent) {
  if (!targetCam.canIngestP2pPacket()) {
    return;
  }

  const meta = videoEvent.metadata || {};
  const codec = meta.videoCodec || 'H265';
  const width = Number(meta.videoWidth) || 0;
  const height = Number(meta.videoHeight) || 0;

  if (targetCam.hasCodecChanged(codec)) {
    log.info(
      targetCam,
      'stream codec changed (' +
        targetCam.getVideoCodec() +
        ' -> ' +
        codec +
        '), resetting decoder (initiator=camera-stream)'
    );
    stopDecoder(targetCam);
  } else if (targetCam.hasDecoderProcess() && targetCam.hasResolutionChanged(width, height)) {
    log.debug(
      targetCam,
      'stream resolution changed in-band (' +
        targetCam.getStreamDimensionsSummary() +
        ' -> ' +
        width +
        'x' +
        height +
        ')'
    );
    targetCam.updateStreamFormat(codec, width, height);
  }

  const packetNow = Date.now();
  const packetBytes = extractPacketBytes(videoEvent);
  if (!targetCam.hasDecoderProcess()) {
    if (
      isP2pDecoderSpawnBackedOff(targetCam, packetNow) ||
      (!isKeyPacket(packetBytes, codec) && !targetCam.isBackfillPlayback())
    ) {
      return;
    }
    targetCam.updateStreamFormat(codec, width, height);
    startDecoder(targetCam);
  }
  targetCam.enqueueOrWriteVideoPacket(packetBytes);
  const {isFirstVideo, elapsedSec} = targetCam.markP2pVideoPacketReceived(packetNow);
  if (isFirstVideo) {
    log.info(
      targetCam,
      'first video (' +
        codec +
        ' ' +
        width +
        'x' +
        height +
        ') ' +
        elapsedSec +
        ' s after wake (session=' +
        targetCam.getSessionId() +
        ')'
    );
  }
}

/**
 * Handles an incoming raw AAC audio packet from eufy-security-ws and forwards it to the active decoder.
 *
 * @param {Camera} targetCam - Camera state object.
 * @param {Record<string, *>} audioEvent - Livestream audio data event.
 */
function onAudio(targetCam, audioEvent) {
  if (targetCam.canIngestP2pPacket() && AUDIO) {
    targetCam.enqueueOrWriteAudioPacket(extractPacketBytes(audioEvent));
  }
}

module.exports = {
  configureDecoderHooks,
  setDecoderStopHandler,
  setRtspDropHandler,
  buildScaleFilter,
  buildP2pDecoderArgs,
  buildRtspDecoderArgs,
  findNalHeaderOffset,
  isKeyPacket,
  attachDecoderStreams,
  handleDecodedP2pFrame,
  handleDecodedRtspFrame,
  handleP2pDecoderExit,
  appendAudioPcmChunk,
  startRtspDecoder,
  flushDecoderInput,
  stopDecoder,
  onVideo,
  onAudio,
};
