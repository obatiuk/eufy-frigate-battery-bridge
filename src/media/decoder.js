// @ts-check
// noinspection JSUnresolvedReference,NpmUsedModulesInstalled
/**
 * Copyright (c) 2026 ljlongwing
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
} = require('../config');
const {log, formatLocalHm} = require('../logger');
const {pushFrameToEncoder, FfmpegArgsBuilder} = require('./encoder');

/** @typedef {import("../domain/camera").Camera} Camera */

const P2P_VIDEO_PROBESIZE_BYTES = '32768';
const P2P_AUDIO_PROBESIZE_BYTES = '1024';
const RTSP_SOCKET_TIMEOUT_US = '5000000';
const RTSP_RETRY_DELAY_MS = 750;
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
      .withLowLatencyFlags()
      .append(
          '-probesize',
          P2P_VIDEO_PROBESIZE_BYTES,
          '-analyzeduration',
          '0',
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
        '-f',
        'aac',
        '-i',
        'pipe:3'
    );
  }

  builder
      .append('-map', '0:v', '-vf', scaleFilter)
      .withRawYuvOutput()
      .withS16leAudioOutput(AUDIO, '1:a', RATE);
  return builder.build();
}

/**
 * Builds the FFmpeg CLI arguments for a low-latency HomeBase RTSP pull decoder.
 *
 * @param {string} rtspUrl - HomeBase RTSP stream URL.
 * @param {string} scaleFilter - FFmpeg -vf scale filter string.
 * @returns {readonly string[]}
 */
function buildRtspDecoderArgs(rtspUrl, scaleFilter) {
  return new FfmpegArgsBuilder()
      .hideBanner()
      .withLowLatencyFlags()
      .append(
          '-rtsp_transport',
          'tcp',
          '-timeout',
          RTSP_SOCKET_TIMEOUT_US,
          '-i',
          rtspUrl,
          '-map',
          '0:v:0',
          '-vf',
          scaleFilter
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
  if (cam.isBackfillPlayback()) {
    const frameCopy = cam.acquireDownloadFrameBuffer(rawBuf);
    if (!cam.bufferDownloadFrame(frameCopy, LIVE_FPS * MAX_DOWNLOAD_BUFFER_SECS)) {
      commitDecodedFrame(cam, frameCopy, frameCopy, now);
    }
    return;
  }

  if (!cam.bufferLiveFrame(rawBuf, now, formatLocalHm(new Date(now)))) {
    const slot = cam.acquireNextLiveFrameSlot(rawBuf);
    commitDecodedFrame(cam, slot, slot, now);
  }

  if (cam.completeStartupProbeIfReady(now, STARTUP_PROBE_CAPTURE_MS) && stopCameraCallback) {
    stopCameraCallback(
        cam,
        'startup snapshot captured after 2s stable video',
        false,
        'bridge-startup-probe'
    );
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
  const {isFirstVideo, isRewakeResume, elapsedSec} = cam.markRtspFrameReceived(now);
  if (isFirstVideo) {
    log.info(cam, 'first RTSP video ' + elapsedSec + ' s after wake (session=' + mySession + ')');
  } else if (isRewakeResume) {
    log.info(
        cam,
        'RTSP video resumed ' + elapsedSec + ' s after mid-session re-wake (session=' + mySession + ')'
    );
  }
  if (!cam.bufferLiveFrame(rawBuf, now, formatLocalHm(new Date(now)))) {
    const slot = cam.acquireNextLiveFrameSlot(rawBuf);
    commitDecodedFrame(cam, slot, slot, now);
  }
}

/**
 * Attaches stdout rawvideo frame chunking, audio PCM pipe ingestion, and stderr tail
 * buffering to a spawned FFmpeg decoder process.
 *
 * @param {Camera} cam - Camera state object.
 * @param {import("child_process").ChildProcess} dec - Spawned FFmpeg decoder.
 * @param {number} mySession - Session identifier.
 * @param {(buf: Uint8Array, now: number) => void} onFrame - Callback invoked for each complete YUV420p frame.
 * @returns {() => string} Getter returning the last line of stderr output.
 */
function attachDecoderStreams(cam, dec, mySession, onFrame) {
  const buf = Buffer.allocUnsafe(FRAME);
  let fill = 0;
  dec.stdout.on('data', (d) => {
    let off = 0;
    while (off < d.length) {
      const n = Math.min(FRAME - fill, d.length - off);
      d.copy(buf, fill, off, off + n);
      fill += n;
      off += n;
      if (fill === FRAME) {
        if (cam.isActiveDecoder(dec, mySession)) {
          onFrame(buf, Date.now());
        }
        fill = 0;
      }
    }
  });

  if (AUDIO && dec.stdio[4]) {
    dec.stdio[4].on('data', (d) => {
      if (cam.isActiveDecoder(dec, mySession)) {
        appendAudioPcmChunk(cam, d);
      }
    });
  }

  const stderrCollector = FfmpegArgsBuilder.attachStderrTailCollector(dec, STDERR_TAIL_MAX_CHARS);
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
  cam.resumeDecoderStdout();
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

  const dec = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe', AUDIO ? 'pipe' : 'ignore', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.attachDecoder(dec);
  log.debug(cam, 'started FFmpeg decoder (codec=' + vfmt + ', session=' + mySession + ')');

  dec.on('error', (e) => log.error(cam, 'decoder process error: ' + e.message));
  dec.stdin.on('error', () => {});
  dec.stdin.on('drain', () => cam.drainPendingDecoderInput(AUDIO, true));
  if (AUDIO && dec.stdio[3]) {
    dec.stdio[3].on('error', () => {});
    dec.stdio[3].on('drain', () => cam.drainPendingDecoderInput(AUDIO, true));
  }

  const getLastStderrLine = attachDecoderStreams(cam, dec, mySession, (frameBuf, now) => {
    handleDecodedP2pFrame(cam, frameBuf, now);
  });

  dec.on('exit', (code) => {
    handleP2pDecoderExit(cam, dec, mySession, code, getLastStderrLine);
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

  const dec = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.attachDecoder(dec, Date.now());
  log.debug(cam, 'started FFmpeg RTSP pull decoder (session=' + mySession + ')');

  dec.on('error', (e) => log.error(cam, 'RTSP decoder process error: ' + e.message));

  const getLastStderrLine = attachDecoderStreams(cam, dec, mySession, (frameBuf, now) => {
    handleDecodedRtspFrame(cam, frameBuf, now, mySession);
  });

  dec.on('exit', (code) => {
    if (cam.detachDecoderIfMatch(dec, true)) {
      if (cam.isCurrentSession(mySession, STREAM_MODES.RTSP)) {
        const lastLine = getLastStderrLine();
        if (cam.isEstablishedRtspStream() && rtspDropCallback) {
          rtspDropCallback(cam, code, lastLine);
          return;
        }
        log.debug(
            cam,
            'RTSP decoder exited while camera waking/streaming (code=' +
            code +
            ', session=' +
            mySession +
            '): ' +
            lastLine +
            ' - retrying in ' +
            RTSP_RETRY_DELAY_MS +
            'ms'
        );
        cam.scheduleRtspDecoderRetry(RTSP_RETRY_DELAY_MS, () => {
          if (cam.canSpawnRtspDecoder(mySession)) {
            startRtspDecoder(cam);
          }
        });
      }
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
 * @param {Camera} cam - Camera state object.
 */
function stopDecoder(cam) {
  const dec = cam.detachDecoder();
  if (!dec) {
    return;
  }
  try {
    if (dec.stdin) {
      dec.stdin.end();
    }
    dec.kill(PROCESS_SIGNALS.SIGTERM);
  } catch (err) {
    // Ignore errors when closing decoder stdin or sending SIGTERM.
  }
  const killTimer = setTimeout(() => {
    try {
      dec.kill(PROCESS_SIGNALS.SIGKILL);
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
 * @param {Record<string, *>} e - Event object containing buffer.
 * @returns {Uint8Array}
 */
const bytes = (e) => Buffer.from((e.buffer && e.buffer.data) ?? e.buffer ?? []);

/**
 * Returns the byte index immediately following an Annex-B start code (00 00 01 or 00 00 00 01)
 * at position 'i', or -1 if no start code begins at 'i'.
 *
 * @param {Uint8Array} buf - Raw video packet buffer.
 * @param {number} i - Current scan index.
 * @returns {number}
 */
function findNalHeaderOffset(buf, i) {
  if (buf[i] !== 0 || buf[i + 1] !== 0) {
    return -1;
  }
  if (buf[i + 2] === 1) {
    return i + 3;
  }
  if (buf[i + 2] === 0 && buf[i + 3] === 1) {
    return i + 4;
  }
  return -1;
}

/**
 * Inspects an Annex-B video packet to determine whether it contains codec parameter sets
 * (HEVC VPS=32 / SPS=33, or H.264 SPS=7) required for FFmpeg to initialize a decoder cleanly.
 *
 * @param {Uint8Array} buf - Raw video packet buffer.
 * @param {string} codec - Video codec string ('H264' or 'H265').
 * @returns {boolean} True if the packet starts with a keyframe parameter set.
 */
function isKeyPacket(buf, codec) {
  const isHevc = HEVC_CODEC_REGEX.test(codec);
  const limit = Math.min(buf.length - 4, KEY_PACKET_SCAN_BYTES);
  for (let i = 0; i < limit; i++) {
    const nalIdx = findNalHeaderOffset(buf, i);
    if (nalIdx < 0 || nalIdx >= buf.length) {
      continue;
    }
    const nalType = isHevc ? (buf[nalIdx] >> 1) & 0x3f : buf[nalIdx] & 0x1f;
    const isParamSet = isHevc
        ? nalType === HEVC_NAL_VPS || nalType === HEVC_NAL_SPS
        : nalType === H264_NAL_SPS;
    if (isParamSet) {
      return true;
    }
    i = nalIdx;
  }
  return false;
}

/**
 * Handles an incoming raw video packet from eufy-security-ws.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} e - Livestream video data event.
 */
function onVideo(cam, e) {
  if (!cam.canIngestP2pPacket()) {
    return;
  }

  const meta = e.metadata || {};
  const codec = meta.videoCodec || 'H265';
  const width = Number(meta.videoWidth) || 0;
  const height = Number(meta.videoHeight) || 0;

  if (cam.hasCodecChanged(codec)) {
    log.info(
        cam,
        'stream codec changed (' +
        cam.getVideoCodec() +
        ' -> ' +
        codec +
        '), resetting decoder (initiator=camera-stream)'
    );
    stopDecoder(cam);
  } else if (cam.hasDecoderProcess() && cam.hasResolutionChanged(width, height)) {
    log.debug(
        cam,
        'stream resolution changed in-band (' +
        cam.getStreamDimensionsSummary() +
        ' -> ' +
        width +
        'x' +
        height +
        ')'
    );
    cam.updateStreamFormat(codec, width, height);
  }

  const now = Date.now();
  const buf = bytes(e);
  if (!cam.hasDecoderProcess()) {
    if (!isKeyPacket(buf, codec) && !cam.isBackfillPlayback()) {
      return;
    }
    cam.updateStreamFormat(codec, width, height);
    startDecoder(cam);
  }
  cam.enqueueOrWriteVideoPacket(buf);
  const {isFirstVideo, elapsedSec} = cam.markP2pVideoPacketReceived(now);
  if (isFirstVideo) {
    log.info(
        cam,
        'first video (' +
        codec +
        ' ' +
        width +
        'x' +
        height +
        ') ' +
        elapsedSec +
        ' s after wake (session=' +
        cam.getSessionId() +
        ')'
    );
  }
}

/**
 * Handles an incoming raw AAC audio packet from eufy-security-ws and forwards it to the active decoder.
 *
 * @param {Camera} cam - Camera state object.
 * @param {Record<string, *>} e - Livestream audio data event.
 */
function onAudio(cam, e) {
  if (cam.canIngestP2pPacket() && AUDIO) {
    cam.enqueueOrWriteAudioPacket(bytes(e));
  }
}

module.exports = {
  setDecoderStopHandler,
  setRtspDropHandler,
  buildScaleFilter,
  buildP2pDecoderArgs,
  buildRtspDecoderArgs,
  findNalHeaderOffset,
  isKeyPacket,
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
