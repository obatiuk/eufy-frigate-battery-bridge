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

const {spawn} = require('child_process');
const {W, H, FRAME, LIVE_FPS, AUDIO, RATE, STDERR_TAIL_MAX_CHARS} = require('../config');
const {log, formatLocalHm} = require('../logger');
const {pushFrameToEncoder} = require('./encoder');

/** @typedef {import("../domain/camera").Camera} Camera */

const P2P_VIDEO_PROBESIZE_BYTES = '32768';
const P2P_AUDIO_PROBESIZE_BYTES = '8192';
const RTSP_SOCKET_TIMEOUT_US = '2500000';
const RTSP_RETRY_DELAY_MS = 750;
const DECODER_SIGKILL_DELAY_MS = 2000;
const STARTUP_PROBE_CAPTURE_MS = 2000;
const BACKFILL_CANCEL_VIDEO_MS = 5000;
const MAX_DOWNLOAD_BUFFER_SECS = 120;
const KEY_PACKET_SCAN_BYTES = 4096;
const HEVC_NAL_VPS = 32;
const HEVC_NAL_SPS = 33;
const H264_NAL_SPS = 7;

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
 * @returns {string[]}
 */
function buildP2pDecoderArgs(vfmt, scaleFilter) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts+nobuffer',
    '-flags',
    'low_delay',
    '-use_wallclock_as_timestamps',
    '1',
    '-probesize',
    P2P_VIDEO_PROBESIZE_BYTES,
    '-analyzeduration',
    '0',
    '-f',
    vfmt,
    '-i',
    'pipe:0',
  ];

  if (AUDIO) {
    args.push(
        '-use_wallclock_as_timestamps',
        '1',
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

  args.push(
      '-map',
      '0:v',
      '-vf',
      scaleFilter,
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      'pipe:1'
  );

  if (AUDIO) {
    args.push('-map', '1:a', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:4');
  }
  return args;
}

/**
 * Builds the FFmpeg CLI arguments for a low-latency HomeBase RTSP pull decoder.
 *
 * @param {string} rtspUrl - HomeBase RTSP stream URL.
 * @param {string} scaleFilter - FFmpeg -vf scale filter string.
 * @returns {string[]}
 */
function buildRtspDecoderArgs(rtspUrl, scaleFilter) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts+nobuffer',
    '-flags',
    'low_delay',
    '-rtsp_transport',
    'tcp',
    '-timeout',
    RTSP_SOCKET_TIMEOUT_US,
    '-i',
    rtspUrl,
    '-map',
    '0:v:0',
    '-vf',
    scaleFilter,
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  if (AUDIO) {
    args.push('-map', '0:a:0?', '-ar', String(RATE), '-ac', '1', '-f', 's16le', 'pipe:4');
  }
  return args;
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
  cam.recordDecodedFrame(
      liveFrame,
      snapshotCopy,
      now,
      formatLocalHm(new Date(now)),
      BACKFILL_CANCEL_VIDEO_MS
  );
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
  const frameCopy = Buffer.from(rawBuf);

  if (cam.isCurrentSession(cam.sessionId, 'download')) {
    if (!cam.bufferDownloadFrame(frameCopy, LIVE_FPS * MAX_DOWNLOAD_BUFFER_SECS)) {
      commitDecodedFrame(cam, frameCopy, frameCopy, now);
    }
    return;
  }

  commitDecodedFrame(cam, rawBuf, frameCopy, now);

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
  commitDecodedFrame(cam, rawBuf, Buffer.from(rawBuf), now);
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
  let buf = Buffer.allocUnsafe(FRAME);
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
        buf = Buffer.allocUnsafe(FRAME);
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

  let tail = '';
  dec.stderr.on('data', (d) => {
    tail = (tail + d).slice(-STDERR_TAIL_MAX_CHARS);
  });
  return () => tail.trim().split('\n').pop() || 'no stderr output';
}

/**
 * Spawns a low-latency per-session FFmpeg decoder for an active camera livestream.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} codec - Video codec name reported by eufy-security-ws ('H264' or 'H265').
 */
function startDecoder(cam, codec) {
  const mySession = cam.sessionId;
  const vfmt = /265|hevc/i.test(codec) ? 'hevc' : 'h264';
  const scaleFilter = buildScaleFilter(cam.preserveAspect);
  const args = buildP2pDecoderArgs(vfmt, scaleFilter);

  const dec = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe', AUDIO ? 'pipe' : 'ignore', AUDIO ? 'pipe' : 'ignore'],
  });
  cam.attachDecoder(dec);
  log.debug(cam, 'started FFmpeg decoder (codec=' + vfmt + ', session=' + mySession + ')');

  dec.on('error', (e) => log.error(cam, 'decoder process error: ' + e.message));
  dec.stdin.on('error', () => {});
  if (AUDIO && dec.stdio[3]) {
    dec.stdio[3].on('error', () => {});
  }

  const getLastStderrLine = attachDecoderStreams(cam, dec, mySession, (frameBuf, now) => {
    handleDecodedP2pFrame(cam, frameBuf, now);
  });

  dec.on('exit', (code) => {
    if (cam.dec === dec) {
      cam.dec = null;
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
  });
}

/**
 * Spawns a low-latency FFmpeg RTSP client decoder that pulls directly from a camera's HomeBase
 * RTSP URL without using the shared P2P livestream slot.
 *
 * @param {Camera} cam - Camera state object.
 * @param {string} rtspUrl - HomeBase RTSP stream URL.
 */
function startRtspDecoder(cam, rtspUrl) {
  if (cam.rtspRetryTimer) {
    clearTimeout(cam.rtspRetryTimer);
    cam.rtspRetryTimer = null;
  }
  const mySession = cam.sessionId;
  const scaleFilter = buildScaleFilter(cam.preserveAspect);
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
    if (cam.dec === dec) {
      cam.dec = null;
      cam.decSpawnedAt = 0;
      if (cam.isCurrentSession(mySession, 'rtsp')) {
        const lastLine = getLastStderrLine();
        if (cam.gotVideo && !cam.rtspRewaking && rtspDropCallback) {
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
        if (cam.rtspRetryTimer) {
          clearTimeout(cam.rtspRetryTimer);
        }
        cam.rtspRetryTimer = setTimeout(() => {
          cam.rtspRetryTimer = null;
          if (cam.isCurrentSession(mySession, 'rtsp') && !cam.dec && cam.rtspUrl) {
            startRtspDecoder(cam, cam.rtspUrl);
          }
        }, RTSP_RETRY_DELAY_MS);
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
  const dec = cam.dec;
  if (!dec) {
    return;
  }
  try {
    if (dec.stdin && dec.stdin.writable) {
      dec.stdin.end();
    }
    if (AUDIO && dec.stdio && dec.stdio[3] && dec.stdio[3].writable) {
      dec.stdio[3].end();
    }
  } catch (err) {
    // Ignore errors when closing decoder input pipes for EOF flush.
  }
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
    dec.kill('SIGTERM');
  } catch (err) {
    // Ignore errors when closing decoder stdin or sending SIGTERM.
  }
  setTimeout(() => {
    try {
      dec.kill('SIGKILL');
    } catch (err) {
      // Ignore errors if decoder already exited.
    }
  }, DECODER_SIGKILL_DELAY_MS);
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
  const isHevc = /265|hevc/i.test(codec);
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
        cam.videoCodec +
        ' -> ' +
        codec +
        '), resetting decoder (initiator=camera-stream)'
    );
    stopDecoder(cam);
  } else if (cam.dec && cam.hasResolutionChanged(width, height)) {
    log.debug(
        cam,
        'stream resolution changed in-band (' +
        cam.videoWidth +
        'x' +
        cam.videoHeight +
        ' -> ' +
        width +
        'x' +
        height +
        ')'
    );
    cam.updateStreamFormat(cam.videoCodec, width, height);
  }

  const now = Date.now();
  const buf = bytes(e);
  if (!cam.dec) {
    if (!isKeyPacket(buf, codec) && !cam.isBackfillPlayback()) {
      return;
    }
    cam.updateStreamFormat(codec, width, height);
    startDecoder(cam, codec);
  }
  if (cam.dec && cam.dec.stdin && cam.dec.stdin.writable) {
    cam.dec.stdin.write(buf);
  }
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
        cam.sessionId +
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
  if (cam.canIngestP2pPacket() && cam.dec && AUDIO && cam.dec.stdio[3] && cam.dec.stdio[3].writable) {
    cam.dec.stdio[3].write(bytes(e));
  }
}

module.exports = {
  setDecoderStopHandler,
  setRtspDropHandler,
  startRtspDecoder,
  flushDecoderInput,
  stopDecoder,
  onVideo,
  onAudio,
};
