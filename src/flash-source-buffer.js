/**
 * @file flash-source-buffer.js
 */
import videojs from 'video.js';
import muxjs from 'mux.js';
import removeCuesFromTrack from './remove-cues-from-track';
import createTextTracksIfNecessary from './create-text-tracks-if-necessary';
import addTextTrackData from './add-text-track-data';
import FlashConstants from './flash-constants';

/**
 * A wrapper around the setTimeout function that uses
 * the flash constant time between ticks value.
 *
 * @param {Function} func the function callback to run
 * @private
 */
const scheduleTick = function(func) {
  // Chrome doesn't invoke requestAnimationFrame callbacks
  // in background tabs, so use setTimeout.
  window.setTimeout(func, FlashConstants.TIME_BETWEEN_CHUNKS);
};

/**
 * Generates a random string of max length 6
 *
 * @return {String} the randomly generated string
 * @function generateRandomString
 * @private
 */
const generateRandomString = function() {
  return (Math.random().toString(36)).slice(2, 8);
};

/**
 * Round a number to a specified number of places much like
 * toFixed but return a number instead of a string representation.
 *
 * @param {Number} num A number
 * @param {Number} places The number of decimal places which to
 * round
 * @private
 */
const toDecimalPlaces = function(num, places) {
  if (typeof places !== 'number' || places < 0) {
    places = 0;
  }

  let scale = Math.pow(10, places);

  return Math.round(num * scale) / scale;
};

const byteArrayToString = function(buffer) {
  let CHUNK_SIZE = 8 * 1024;
  let str = '';

  if (buffer.length <= CHUNK_SIZE) {
    return String.fromCharCode.apply(null, buffer);
  }
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    str += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK_SIZE));
  }
  return str;
};

/**
 * A SourceBuffer implementation for Flash rather than HTML.
 *
 * @link https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
 * @param {Object} mediaSource the flash media source
 * @class FlashSourceBuffer
 * @extends videojs.EventTarget
 */
export default class FlashSourceBuffer extends videojs.EventTarget {
  constructor(mediaSource) {
    super();
    let encodedHeader;

    // Start off using the globally defined value but refine
    // as we append data into flash
    this.chunkSize_ = FlashConstants.BYTES_PER_CHUNK;

    // byte arrays queued to be appended
    this.buffer_ = [];

    // the total number of queued bytes
    this.bufferSize_ = 0;

    // to be able to determine the correct position to seek to, we
    // need to retain information about the mapping between the
    // media timeline and PTS values
    this.basePtsOffset_ = NaN;

    this.mediaSource = mediaSource;

    // indicates whether the asynchronous continuation of an operation
    // is still being processed
    // see https://w3c.github.io/media-source/#widl-SourceBuffer-updating
    this.updating = false;
    this.timestampOffset_ = 0;

    // TS to FLV transmuxer
    this.segmentParser_ = new muxjs.flv.Transmuxer();
    this.segmentParser_.on('data', this.receiveBuffer_.bind(this));
    encodedHeader = window.btoa(
      String.fromCharCode.apply(
        null,
        Array.prototype.slice.call(
          this.segmentParser_.getFlvHeader()
        )
      )
    );

    const safePlayerId = this.mediaSource.player_.id().replace(/[^a-zA-Z0-9]/g, '_');

    this.flashEncodedHeaderName_ = 'vjs_flashEncodedHeader_' +
                                   safePlayerId +
                                   generateRandomString();
    this.flashEncodedDataName_ = 'vjs_flashEncodedData_' +
                                   safePlayerId +
                                   generateRandomString();

    window[this.flashEncodedHeaderName_] = () => {
      delete window[this.flashEncodedHeaderName_];
      return encodedHeader;
    };

    this.mediaSource.swfObj.vjs_appendChunkReady(this.flashEncodedHeaderName_);

    Object.defineProperty(this, 'timestampOffset', {
      get() {
        return this.timestampOffset_;
      },
      set(val) {
        if (typeof val === 'number' && val >= 0) {
          this.timestampOffset_ = val;
          this.segmentParser_ = new muxjs.flv.Transmuxer();
          this.segmentParser_.on('data', this.receiveBuffer_.bind(this));
          // We have to tell flash to expect a discontinuity
          this.mediaSource.swfObj.vjs_discontinuity();
          // the media <-> PTS mapping must be re-established after
          // the discontinuity
          this.basePtsOffset_ = NaN;
        }
      }
    });

    Object.defineProperty(this, 'buffered', {
      get() {
        if (!this.mediaSource ||
            !this.mediaSource.swfObj ||
            !('vjs_getProperty' in this.mediaSource.swfObj)) {
          return videojs.createTimeRange();
        }

        let buffered = this.mediaSource.swfObj.vjs_getProperty('buffered');

        if (buffered && buffered.length) {
          buffered[0][0] = toDecimalPlaces(buffered[0][0], 3);
          buffered[0][1] = toDecimalPlaces(buffered[0][1], 3);
        }
        return videojs.createTimeRanges(buffered);
      }
    });

    // On a seek we remove all text track data since flash has no concept
    // of a buffered-range and everything else is reset on seek
    this.mediaSource.player_.on('seeked', () => {
      removeCuesFromTrack(0, Infinity, this.metadataTrack_);
      removeCuesFromTrack(0, Infinity, this.inbandTextTrack_);
    });
  }

  /**
   * Append bytes to the sourcebuffers buffer, in this case we
   * have to append it to swf object.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/appendBuffer
   * @param {Array} bytes
   */
  appendBuffer(bytes) {
    let error;
    let chunk = 512 * 1024;
    let i = 0;

    if (this.updating) {
      error = new Error('SourceBuffer.append() cannot be called ' +
                        'while an update is in progress');
      error.name = 'InvalidStateError';
      error.code = 11;
      throw error;
    }

    this.updating = true;
    this.mediaSource.readyState = 'open';
    this.trigger({ type: 'update' });

    // this is here to use recursion
    let chunkInData = () => {
      this.segmentParser_.push(bytes.subarray(i, i + chunk));
      i += chunk;
      if (i < bytes.byteLength) {
        scheduleTick(chunkInData);
      } else {
        scheduleTick(this.segmentParser_.flush.bind(this.segmentParser_));
      }
    };

    chunkInData();
  }

  /**
   * Reset the parser and remove any data queued to be sent to the SWF.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/abort
   */
  abort() {
    this.buffer_ = [];
    this.bufferSize_ = 0;
    this.mediaSource.swfObj.vjs_abort();

    // report any outstanding updates have ended
    if (this.updating) {
      this.updating = false;
      this.trigger({ type: 'updateend' });
    }
  }

  /**
   * Flash cannot remove ranges already buffered in the NetStream
   * but seeking clears the buffer entirely. For most purposes,
   * having this operation act as a no-op is acceptable.
   *
   * @link https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/remove
   * @param {Double} start start of the section to remove
   * @param {Double} end end of the section to remove
   */
  remove(start, end) {
    removeCuesFromTrack(start, end, this.metadataTrack_);
    removeCuesFromTrack(start, end, this.inbandTextTrack_);
    this.trigger({ type: 'update' });
    this.trigger({ type: 'updateend' });
  }

  /**
   * Receive a buffer from the flv.
   *
   * @param {Object} segment
   * @private
   */
  receiveBuffer_(segment) {
    // create an in-band caption track if one is present in the segment
    createTextTracksIfNecessary(this, this.mediaSource, segment);
    addTextTrackData(this, segment.captions, segment.metadata);

    // Do this asynchronously since convertTagsToData_ can be time consuming
    scheduleTick(() => {
      let flvBytes = this.convertTagsToData_(segment);

      if (this.buffer_.length === 0) {
        scheduleTick(this.processBuffer_.bind(this));
      }

      if (flvBytes) {
        this.buffer_.push(flvBytes);
        this.bufferSize_ += flvBytes.byteLength;
      }
    });
  }

  /**
   * Append a portion of the current buffer to the SWF.
   *
   * @private
   */
  processBuffer_() {
    let chunkSize = FlashConstants.BYTES_PER_CHUNK;

    if (!this.buffer_.length) {
      if (this.updating !== false) {
        this.updating = false;
        this.trigger({ type: 'updateend' });
      }
      // do nothing if the buffer is empty
      return;
    }

    // concatenate appends up to the max append size
    let payload = new Uint8Array(Math.min(chunkSize, this.bufferSize_));
    let i = payload.byteLength;

    while (i) {
      let chunk = this.buffer_[0].subarray(0, i);

      payload.set(chunk, payload.byteLength - i);
     // requeue any bytes that won't make it this round
      if (chunk.byteLength < this.buffer_[0].byteLength) {
        this.buffer_[0] = this.buffer_[0].subarray(i);
      } else {
        this.buffer_.shift();
      }
      i -= chunk.byteLength;
    }
    this.bufferSize_ -= payload.byteLength;

    let b64str = window.btoa(byteArrayToString(payload));

    window[this.flashEncodedDataName_] = () => {
      // schedule another processBuffer to process any left over data or to
      // trigger updateend
      scheduleTick(this.processBuffer_.bind(this));
      delete window[this.flashEncodedDataName_];
      return b64str;
    };

    // Notify the swf that segment data is ready to be appended
    this.mediaSource.swfObj.vjs_appendChunkReady(this.flashEncodedDataName_);
  }

  /**
   * Turns an array of flv tags into a Uint8Array representing the
   * flv data. Also removes any tags that are before the current
   * time so that playback begins at or slightly after the right
   * place on a seek
   *
   * @private
   * @param {Object} segmentData object of segment data
   */
  convertTagsToData_(segmentData) {
    let segmentByteLength = 0;
    let tech = this.mediaSource.tech_;
    let targetPts = 0;
    let i;
    let j;
    let segment;
    let filteredTags = [];
    let tags = this.getOrderedTags_(segmentData);

    // Establish the media timeline to PTS translation if we don't
    // have one already
    if (isNaN(this.basePtsOffset_) && tags.length) {
      this.basePtsOffset_ = tags[0].pts;
    }

    // Trim any tags that are before the end of the end of
    // the current buffer
    if (tech.buffered().length) {
      targetPts = tech.buffered().end(0) - this.timestampOffset;
    }
    // Trim to currentTime if it's ahead of buffered or buffered doesn't exist
    targetPts = Math.max(targetPts, tech.currentTime() - this.timestampOffset);

    // PTS values are represented in milliseconds
    targetPts *= 1e3;
    targetPts += this.basePtsOffset_;

    // skip tags with a presentation time less than the seek target
    for (i = 0; i < tags.length; i++) {
      if (tags[i].pts >= targetPts) {
        filteredTags.push(tags[i]);
      }
    }

    if (filteredTags.length === 0) {
      return;
    }

    // concatenate the bytes into a single segment
    for (i = 0; i < filteredTags.length; i++) {
      segmentByteLength += filteredTags[i].bytes.byteLength;
    }
    segment = new Uint8Array(segmentByteLength);
    for (i = 0, j = 0; i < filteredTags.length; i++) {
      segment.set(filteredTags[i].bytes, j);
      j += filteredTags[i].bytes.byteLength;
    }

    return segment;
  }

  /**
   * Assemble the FLV tags in decoder order.
   *
   * @private
   * @param {Object} segmentData object of segment data
   */
  getOrderedTags_(segmentData) {
    let videoTags = segmentData.tags.videoTags;
    let audioTags = segmentData.tags.audioTags;
    let tag;
    let tags = [];

    while (videoTags.length || audioTags.length) {
      if (!videoTags.length) {
        // only audio tags remain
        tag = audioTags.shift();
      } else if (!audioTags.length) {
        // only video tags remain
        tag = videoTags.shift();
      } else if (audioTags[0].dts < videoTags[0].dts) {
        // audio should be decoded next
        tag = audioTags.shift();
      } else {
        // video should be decoded next
        tag = videoTags.shift();
      }

      tags.push(tag.finalize());
    }

    return tags;
  }
}

