/**
 * AudioEngine - Singleton class managing all Web Audio API operations
 * Supports dynamic oscillator count (2-10), multi-channel routing, and device selection.
 * Isolated from React to prevent re-renders from interfering with audio timing.
 */

class AudioEngine {
  constructor() {
    if (AudioEngine.instance) {
      return AudioEngine.instance;
    }
    
    this.AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = null;
    this.oscillators = [];
    this.gainNodes = [];         // Volume control per oscillator
    this.routingNodes = [];      // Routing control per oscillator (for channel assignment)
    this.masterGainNode = null;
    this.analyserNode1 = null;   // Left channel visualization
    this.analyserNode2 = null;   // Right channel visualization
    this.isInitialized = false;
    this.isPaused = false;
    
    // Dynamic oscillator management
    this.oscillatorCount = 4;
    this.maxOscillators = 10;
    this.minOscillators = 2;

    // User-controllable master volume multiplier (0..1). Multiplies on top of
    // the count-based clipping scaler in _getScaledMasterGain so fade-in/out
    // and oscillator add/remove transitions naturally honor it.
    this.masterVolumeUser = 1.0;

    // Stack of per-osc state captured when an oscillator is removed via
    // setOscillatorCount. Re-adding pops the most-recently-removed state so
    // the user's freq/volume/mute settings come back instead of being random.
    this.removedSlots = [];
    
    // Generate random default frequencies
    // First two oscillators: 50-130 Hz, 1-4 Hz apart
    const baseFreq1 = 50 + Math.random() * 80; // 50-130 Hz
    const offset1 = 1 + Math.random() * 3; // 1-4 Hz
    const freq1 = baseFreq1;
    const freq2 = baseFreq1 + (Math.random() > 0.5 ? offset1 : -offset1);
    
    // Second two oscillators: 2x the base, also 1-4 Hz apart
    const baseFreq2 = baseFreq1 * 2;
    const offset2 = 1 + Math.random() * 3; // 1-4 Hz
    const freq3 = baseFreq2;
    const freq4 = baseFreq2 + (Math.random() > 0.5 ? offset2 : -offset2);
    
    // Store frequency/volume values separately from oscillator nodes
    this.frequencyValues = [freq1, freq2, freq3, freq4];
    this.volumeValues = [0.5, 0.5, 0.5, 0.5];
    this.mutedStates = [false, false, true, true]; // 3rd and 4th muted by default
    this.preMuteVolumes = [0.5, 0.5, 0.5, 0.5];

    // Per-oscillator phase accumulators (radians, 0..2π) mirroring the
    // actual running Web Audio oscillators. Advanced by updatePhases()
    // from the visualizer each frame via an exponentially-smoothed
    // target frequency — the smoothing tau matches setFrequency's
    // setTargetAtTime tau (0.016 s), so the accumulator stays aligned
    // with the audio across frequency slider drags.
    this.phases = [];
    this.smoothedFreqs = [];
    this._lastPhaseUpdate = [];
    this._phaseSmoothTau = 0.016;

    // Per-channel joint-least-squares phase-recovery caches. Each holds
    // { sig, oscs, LL, P, N } where LL is the in-place Cholesky factor
    // of M^T M and `sig` is the routing+frequency signature used to
    // decide whether the factorization is still valid. Re-built lazily
    // inside calibratePhases when sig changes.
    this._lsqCacheL = null;
    this._lsqCacheR = null;
    
    // Multi-channel routing - maps oscillator index to array of output channels
    this.routingMap = {}; // { oscIndex: [outputChannel1, outputChannel2, ...] }
    this.outputChannelCount = 2; // Default stereo
    
    // Device management
    this.currentDeviceId = null;
    
    // Audio graph nodes for routing
    this.channelGains = [];      // One gain per output channel for final mixing
    this.stereoMerger = null;    // Merges channels to stereo for output
    
    // Callbacks for state change notifications
    this.onRoutingChange = null;
    
    AudioEngine.instance = this;
  }
  
  /**
   * Initialize the audio context and create all nodes
   * Must be called from a user gesture (click/touch)
   */
  initialize(initialFrequencies = null, initialVolumes = null) {
    if (this.isInitialized) return;
    
    // Apply initial values if provided (e.g., from URL)
    if (initialFrequencies && initialFrequencies.length >= 2) {
      this.oscillatorCount = Math.min(initialFrequencies.length, this.maxOscillators);
      this.frequencyValues = initialFrequencies.slice(0, this.oscillatorCount);
    }
    if (initialVolumes && initialVolumes.length >= 2) {
      this.volumeValues = initialVolumes.slice(0, this.oscillatorCount).map(v => v / 100);
    }
    
    // Ensure arrays are properly sized
    while (this.frequencyValues.length < this.oscillatorCount) {
      this.frequencyValues.push(60);
    }
    while (this.volumeValues.length < this.oscillatorCount) {
      this.volumeValues.push(0.5);
    }
    while (this.mutedStates.length < this.oscillatorCount) {
      this.mutedStates.push(false);
    }
    while (this.preMuteVolumes.length < this.oscillatorCount) {
      this.preMuteVolumes.push(0.5);
    }

    // Pre-size phase arrays; per-osc values are finalized in
    // _createSingleOscillator once audioContext.currentTime is known.
    this.phases = new Array(this.oscillatorCount).fill(0);
    this.smoothedFreqs = this.frequencyValues.slice(0, this.oscillatorCount);
    this._lastPhaseUpdate = new Array(this.oscillatorCount).fill(null);

    this.audioContext = new this.AudioContextClass();
    
    // Create analyser nodes for visualization
    this.analyserNode1 = this.audioContext.createAnalyser();
    this.analyserNode2 = this.audioContext.createAnalyser();
    // 8192 gives calibratePhases() a ~5.4 Hz Goertzel frequency
    // resolution (sampleRate / fftSize) — small enough that oscillators
    // spaced a few Hz apart (typical beating setups) don't smear too
    // badly into each other's bins. Also still fast: 8192 float32 ≈
    // 32 KB per channel analyzer buffer.
    this.analyserNode1.fftSize = 8192;
    this.analyserNode2.fftSize = 8192;
    
    // Pre-allocate Float32Arrays for visualization
    this.timeData1 = new Float32Array(this.analyserNode1.fftSize);
    this.timeData2 = new Float32Array(this.analyserNode2.fftSize);
    
    // Create master gain node
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    
    // Create channel gain nodes (one per output channel for mixing)
    this.channelGains = [
      this.audioContext.createGain(), // Left channel
      this.audioContext.createGain()  // Right channel
    ];
    
    // Create stereo merger
    this.stereoMerger = this.audioContext.createChannelMerger(2);
    
    // Connect channel gains to stereo merger
    this.channelGains[0].connect(this.stereoMerger, 0, 0); // Left
    this.channelGains[1].connect(this.stereoMerger, 0, 1); // Right
    
    // Connect stereo merger to master gain
    this.stereoMerger.connect(this.masterGainNode);
    
    // Create splitter for visualization (after master gain)
    const splitter = this.audioContext.createChannelSplitter(2);
    const finalMerger = this.audioContext.createChannelMerger(2);
    
    this.masterGainNode.connect(splitter);
    splitter.connect(this.analyserNode1, 0);
    splitter.connect(this.analyserNode2, 1);
    this.analyserNode1.connect(finalMerger, 0, 0);
    this.analyserNode2.connect(finalMerger, 0, 1);
    finalMerger.connect(this.audioContext.destination);
    
    // Get max channel count from destination
    this.outputChannelCount = this.audioContext.destination.maxChannelCount || 2;
    console.log('Max output channels available:', this.outputChannelCount);
    
    // Create initial oscillators with default routing
    this._createOscillators();
    
    // Setup default routing (odd → left, even → right)
    this._setupDefaultRouting();
    
    // Fade in
    this.masterGainNode.gain.setTargetAtTime(this._getScaledMasterGain(), this.audioContext.currentTime, 0.1);
    
    this.isInitialized = true;
    this.isPaused = false;
  }
  
  /**
   * Get scaled master gain based on oscillator count to prevent clipping,
   * multiplied by the user master volume.
   */
  _getScaledMasterGain() {
    return (1.0 / Math.sqrt(this.oscillatorCount / 2)) * this.masterVolumeUser;
  }

  setMasterVolume(value) {
    const clamped = Math.max(0, Math.min(1, value));
    this.masterVolumeUser = clamped;
    if (this.isInitialized && !this.isPaused && this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(
        this._getScaledMasterGain(),
        this.audioContext.currentTime,
        0.05
      );
    }
  }

  getMasterVolume() {
    return this.masterVolumeUser;
  }

  /**
   * Instantaneous master gain as the audio graph currently has it —
   * includes the user's master-volume slider, the count-based clip
   * scale, and any in-flight fadeIn/fadeOut/pause ramp. This is what
   * the analyzer actually sees, so visualizers wanting to match the
   * audio through transitions should multiply their amplitudes by this
   * instead of computing the target scale from masterVolumeUser alone.
   */
  getCurrentMasterGain() {
    if (!this.isInitialized || !this.masterGainNode) return 0;
    return this.masterGainNode.gain.value;
  }


  /**
   * Update master gain scaling when oscillator count changes
   */
  _updateMasterGainScaling() {
    if (!this.isInitialized || this.isPaused) return;
    
    const targetGain = this._getScaledMasterGain();
    this.masterGainNode.gain.setTargetAtTime(
      targetGain,
      this.audioContext.currentTime,
      0.1
    );
  }
  
  /**
   * Create oscillators based on current count
   */
  _createOscillators() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this._createSingleOscillator(i);
    }
  }
  
  /**
   * Create a single oscillator at the specified index
   */
  _createSingleOscillator(index) {
    try {
      if (!this.audioContext) {
        console.error('AudioEngine: Cannot create oscillator - audio context not ready');
        return;
      }
      
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      
      // Default routing: odd indices → left (0), even indices → right (1)
      const defaultChannel = index % 2;
      this.routingMap[index] = [defaultChannel];
      
      // Connect to the appropriate channel gain
      gainNode.connect(this.channelGains[defaultChannel]);
      
      // Set initial frequency and volume
      const freq = this.frequencyValues[index] || 60;
      const vol = this.mutedStates[index] ? 0 : (this.volumeValues[index] || 0.5);
      
      oscillator.frequency.setValueAtTime(freq, this.audioContext.currentTime);
      gainNode.gain.setValueAtTime(vol, this.audioContext.currentTime);
      
      oscillator.start();

      this.oscillators[index] = oscillator;
      this.gainNodes[index] = gainNode;

      // Seed phase accumulator to 0 at the moment start() takes effect.
      // Web Audio oscillators begin at phase 0 relative to their start
      // time, so pinning _lastPhaseUpdate here keeps the next
      // updatePhases() aligned to the real audio.
      this.phases[index] = 0;
      this.smoothedFreqs[index] = freq;
      this._lastPhaseUpdate[index] = this.audioContext.currentTime;
    } catch (err) {
      console.error('AudioEngine: Failed to create oscillator', index, err);
    }
  }
  
  /**
   * Setup default routing (odd → left, even → right)
   */
  _setupDefaultRouting() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this.routingMap[i] = [i % 2]; // 0=left, 1=right as array
    }
  }
  
  /**
   * Set oscillator count (2-10)
   */
  setOscillatorCount(count) {
    try {
      if (!this.isInitialized) {
        this.oscillatorCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));
        return;
      }
      
      const newCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));
      
      if (newCount === this.oscillatorCount) return;
      
      const oldCount = this.oscillatorCount;
      
      if (newCount > oldCount) {
        // Add oscillators - update count first so arrays are in sync
        this.oscillatorCount = newCount;

        for (let i = oldCount; i < newCount; i++) {
          // Restore the most-recently-removed slot if available; otherwise
          // generate a random pitch near an existing oscillator.
          const restored = this.removedSlots.pop();
          if (restored) {
            this.frequencyValues[i] = restored.freq;
            this.volumeValues[i] = restored.vol;
            this.mutedStates[i] = restored.muted;
            this.preMuteVolumes[i] = restored.preMuteVol;
          } else {
            const randomIndex = Math.floor(Math.random() * oldCount);
            const basePitch = this.frequencyValues[randomIndex] || 60;
            const newPitch = basePitch + (Math.random() * 6 - 3);
            this.frequencyValues[i] = Math.max(0.1, newPitch);
            this.volumeValues[i] = 0.5;
            this.mutedStates[i] = false;
            this.preMuteVolumes[i] = 0.5;
          }

          this._createSingleOscillator(i);
        }
      } else {
        // Remove oscillators - capture state first so re-adding restores it
        for (let i = oldCount - 1; i >= newCount; i--) {
          this.removedSlots.push({
            freq: this.frequencyValues[i],
            vol: this.volumeValues[i],
            muted: this.mutedStates[i],
            preMuteVol: this.preMuteVolumes[i],
          });

          try {
            if (this.oscillators[i]) {
              this.oscillators[i].stop();
              this.oscillators[i].disconnect();
            }
            if (this.gainNodes[i]) {
              this.gainNodes[i].disconnect();
            }
          } catch (e) {
            console.warn('Error stopping oscillator', i, e);
          }

          this.oscillators.splice(i, 1);
          this.gainNodes.splice(i, 1);
          this.frequencyValues.splice(i, 1);
          this.volumeValues.splice(i, 1);
          this.mutedStates.splice(i, 1);
          this.preMuteVolumes.splice(i, 1);
          this.phases.splice(i, 1);
          this.smoothedFreqs.splice(i, 1);
          this._lastPhaseUpdate.splice(i, 1);
          delete this.routingMap[i];
        }

        this.oscillatorCount = newCount;
      }
      
      // Update master gain scaling to prevent clipping
      this._updateMasterGainScaling();
    } catch (err) {
      console.error('AudioEngine: Failed to set oscillator count', err);
    }
  }
  
  /**
   * Get current oscillator count
   */
  getOscillatorCount() {
    return this.oscillatorCount;
  }
  
  /**
   * Add routing for an oscillator to a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to add
   */
  addRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    if (outputChannel === null || outputChannel === undefined) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const newChannel = Math.max(0, Math.min(outputChannel, this.channelGains.length - 1));
    
    // Skip if already routed to this channel
    if (channels.includes(newChannel)) return;
    
    try {
      // Connect to new channel (don't disconnect existing connections)
      this.gainNodes[oscIndex].connect(this.channelGains[newChannel]);
      
      // Update routing map
      this.routingMap[oscIndex] = [...channels, newChannel];
      
      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to add routing', err);
    }
  }
  
  /**
   * Remove routing for an oscillator from a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to remove
   */
  removeRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const channelIndex = channels.indexOf(outputChannel);
    
    if (channelIndex === -1) return;
    
    try {
      // Disconnect from all channels and reconnect to remaining ones
      this.gainNodes[oscIndex].disconnect();
      
      // Update routing map - just remove the channel, don't reassign
      const newChannels = channels.filter(ch => ch !== outputChannel);
      this.routingMap[oscIndex] = newChannels;
      
      // Reconnect to remaining channels (if any)
      for (const ch of newChannels) {
        this.gainNodes[oscIndex].connect(this.channelGains[ch]);
      }
      
      // If no channels left, oscillator is disconnected (silent) - that's okay
      
      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to remove routing', err);
    }
  }
  
  /**
   * Clear all routings going to a specific output channel
   * @param {number} outputChannel - Output channel to clear
   */
  clearOutputChannel(outputChannel) {
    if (!this.isInitialized) return;
    
    for (let oscIndex = 0; oscIndex < this.oscillatorCount; oscIndex++) {
      const channels = this.routingMap[oscIndex] || [];
      if (channels.includes(outputChannel)) {
        this.removeRouting(oscIndex, outputChannel);
      }
    }
  }
  
  /**
   * Set routing for an oscillator (legacy - now adds to existing routings)
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number|null} outputChannel - Output channel to add
   */
  setRouting(oscIndex, outputChannel) {
    this.addRouting(oscIndex, outputChannel);
  }
  
  /**
   * Get current routing map
   */
  getRoutingMap() {
    return { ...this.routingMap };
  }
  
  /**
   * Get max output channels available
   */
  getMaxOutputChannels() {
    if (!this.isInitialized) return 2;
    return this.outputChannelCount;
  }
  
  /**
   * Set output device
   */
  async setOutputDevice(deviceId) {
    if (!this.isInitialized) {
      this.currentDeviceId = deviceId;
      return;
    }
    
    if (typeof this.audioContext.setSinkId === 'function') {
      try {
        await this.audioContext.setSinkId(deviceId);
        this.currentDeviceId = deviceId;
        
        // Update channel count after device change
        const newChannelCount = this.audioContext.destination.maxChannelCount || 2;
        console.log('New device channel count:', newChannelCount);
        
        if (newChannelCount !== this.outputChannelCount) {
          this.outputChannelCount = newChannelCount;
          this._rebuildChannelRouting();
        }
      } catch (err) {
        console.error('Failed to set output device:', err);
      }
    } else {
      console.warn('setSinkId not supported in this browser');
    }
  }
  
  /**
   * Rebuild channel routing for new channel count
   */
  _rebuildChannelRouting() {
    if (!this.isInitialized) return;
    
    console.log('Rebuilding channel routing for', this.outputChannelCount, 'channels');
    
    // Disconnect all oscillator gain nodes from current channel gains
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (this.gainNodes[i]) {
        try {
          this.gainNodes[i].disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
    }
    
    // Disconnect old channel gains from merger
    for (const channelGain of this.channelGains) {
      try {
        channelGain.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Disconnect old merger
    if (this.stereoMerger) {
      try {
        this.stereoMerger.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Create new channel gains for all output channels (but we still visualize as stereo)
    // Channels 0,2,4... go to left visualizer, 1,3,5... go to right visualizer
    const numChannels = Math.min(this.outputChannelCount, 32); // Reasonable limit
    
    // Create new channel gains
    this.channelGains = [];
    for (let i = 0; i < numChannels; i++) {
      this.channelGains.push(this.audioContext.createGain());
    }
    
    // Create new merger with correct channel count
    this.stereoMerger = this.audioContext.createChannelMerger(numChannels);
    
    // Connect channel gains to merger
    for (let i = 0; i < numChannels; i++) {
      this.channelGains[i].connect(this.stereoMerger, 0, i);
    }
    
    // Connect merger to master gain
    this.stereoMerger.connect(this.masterGainNode);
    
    // Re-setup default routing for current oscillators
    this._setupDefaultRouting();
    
    // Reconnect all oscillator gain nodes to their channel gains
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (this.gainNodes[i]) {
        const channels = this.routingMap[i] || [i % numChannels];
        for (const ch of channels) {
          if (ch < this.channelGains.length) {
            this.gainNodes[i].connect(this.channelGains[ch]);
          }
        }
      }
    }
    
    console.log('Channel routing rebuilt for', numChannels, 'channels');
  }
  
  /**
   * Get available audio output devices
   */
  async getAudioOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audiooutput');
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return [];
    }
  }
  
  /**
   * Set frequency for a specific oscillator
   */
  setFrequency(index, frequency) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.oscillators[index]) return;
    
    const clampedFreq = Math.max(0.001, Math.min(20000, frequency));
    
    if (Math.abs(clampedFreq - this.frequencyValues[index]) < 0.01) return;
    
    this.frequencyValues[index] = clampedFreq;
    
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.oscillators[index].frequency.setTargetAtTime(
      clampedFreq,
      this.audioContext.currentTime,
      0.016
    );
  }
  
  /**
   * Set volume for a specific oscillator (0-1 range)
   */
  setVolume(index, volume) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.gainNodes[index]) return;
    
    const clampedVol = Math.max(0, Math.min(1, volume));
    
    if (Math.abs(clampedVol - this.volumeValues[index]) < 0.005) return;
    
    this.volumeValues[index] = clampedVol;
    
    if (this.mutedStates[index]) {
      this.preMuteVolumes[index] = clampedVol;
      return;
    }
    
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    
    this.gainNodes[index].gain.setTargetAtTime(
      clampedVol,
      this.audioContext.currentTime,
      0.016
    );
  }
  
  /**
   * Apply frequencies to every oscillator in one pass, scheduling every
   * AudioParam change at the same currentTime so the relative offsets between
   * oscillators stay exactly preserved (critical for beat-preserving drags).
   */
  setAllFrequenciesBatch(frequencies) {
    if (!this.isInitialized) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    const t = this.audioContext.currentTime;
    const count = Math.min(frequencies.length, this.oscillatorCount);
    for (let i = 0; i < count; i++) {
      if (!this.oscillators[i]) continue;
      const clampedFreq = Math.max(0.001, Math.min(20000, frequencies[i]));
      if (Math.abs(clampedFreq - this.frequencyValues[i]) < 0.01) continue;
      this.frequencyValues[i] = clampedFreq;
      this.oscillators[i].frequency.setTargetAtTime(clampedFreq, t, 0.016);
    }
  }

  /**
   * Batch volume update sibling of setAllFrequenciesBatch — single currentTime
   * read so relative volume ratios can't drift during a global drag.
   * Volumes are on the 0-1 scale.
   */
  setAllVolumesBatch(volumes) {
    if (!this.isInitialized) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    const t = this.audioContext.currentTime;
    const count = Math.min(volumes.length, this.oscillatorCount);
    for (let i = 0; i < count; i++) {
      if (!this.gainNodes[i]) continue;
      const clampedVol = Math.max(0, Math.min(1, volumes[i]));
      if (Math.abs(clampedVol - this.volumeValues[i]) < 0.005) continue;
      this.volumeValues[i] = clampedVol;
      if (this.mutedStates[i]) {
        this.preMuteVolumes[i] = clampedVol;
        continue;
      }
      this.gainNodes[i].gain.setTargetAtTime(clampedVol, t, 0.016);
    }
  }

  /**
   * 7-limit just-intonation ratios within one octave, in ascending order.
   * Extends the classical 5-limit major scale (the iOS port) with the
   * "pleasing ratios outside Western scales": subminor/supermajor 3rds,
   * septimal tritone, harmonic 7th, minor-key intervals, and a diatonic
   * semitone. 15 ratios across the octave → ~60-90¢ decision boundaries in
   * log-space nearest-neighbor, so Tune rarely yanks an osc far from where
   * it already lived.
   */
  static JUST_RATIOS = [
    1.0,          // 1/1    0¢    unison
    16.0 / 15.0,  //        112¢  diatonic semitone (minor 2nd)
    9.0 / 8.0,    //        204¢  whole tone (major 2nd)
    7.0 / 6.0,    //        267¢  septimal subminor 3rd
    6.0 / 5.0,    //        316¢  minor 3rd
    5.0 / 4.0,    //        386¢  major 3rd
    9.0 / 7.0,    //        435¢  septimal supermajor 3rd
    4.0 / 3.0,    //        498¢  perfect 4th
    7.0 / 5.0,    //        583¢  septimal tritone
    3.0 / 2.0,    //        702¢  perfect 5th
    8.0 / 5.0,    //        814¢  minor 6th
    5.0 / 3.0,    //        884¢  major 6th
    7.0 / 4.0,    //        969¢  harmonic 7th (barbershop / blues 7th)
    9.0 / 5.0,    //        1018¢ minor 7th
    15.0 / 8.0,   //        1088¢ major 7th
    2.0,          // 2/1    1200¢ octave — same pitch as 1/1 of the next
                  //        octave up; included so a near-octave osc (e.g.
                  //        ratio 1.985) rounds up to 2/1 instead of down to
                  //        15/8 (floor-octave trap otherwise).
  ];

  /**
   * Compute per-oscillator target frequencies that snap each non-fundamental
   * oscillator to the nearest 7-limit JI ratio relative to the lowest un-muted
   * oscillator. Octave-preserving and log-space nearest-neighbor. Pure
   * function — returns targets without touching audio state.
   *
   * @param {number} varianceHz  Random ±Hz detune added per osc after snapping
   *                             (matches iOS alignVariance). 0 = pure JI.
   */
  computeJustIntonationTargets(varianceHz = 0) {
    const out = this.frequencyValues.slice();
    const ratios = AudioEngine.JUST_RATIOS;
    // Fundamental = lowest un-muted oscillator by frequency. Fall back to the
    // lowest overall if every osc is muted so the button still does something.
    let fundamentalIdx = -1;
    let fundamentalFreq = Infinity;
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (this.mutedStates[i]) continue;
      if (this.frequencyValues[i] < fundamentalFreq) {
        fundamentalFreq = this.frequencyValues[i];
        fundamentalIdx = i;
      }
    }
    if (fundamentalIdx === -1) {
      for (let i = 0; i < this.oscillatorCount; i++) {
        if (this.frequencyValues[i] < fundamentalFreq) {
          fundamentalFreq = this.frequencyValues[i];
          fundamentalIdx = i;
        }
      }
    }
    if (fundamentalIdx === -1 || fundamentalFreq <= 0) return out;

    // Simple nearest-neighbor: each non-root osc snaps to whichever ratio in
    // the table is closest in log space, at its current octave. Duplicate
    // collapses (two oscs landing on the same pitch) are allowed — if the
    // inputs were already near each other, stacking is the natural result.
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (i === fundamentalIdx) continue;
      const f = this.frequencyValues[i];
      if (f <= 0) continue;
      const ratio = f / fundamentalFreq;
      const octave = Math.floor(Math.log2(ratio));
      const normalized = ratio / Math.pow(2, octave); // [1, 2)
      const logNorm = Math.log2(normalized);

      let bestRatio = ratios[0];
      let bestDist = Math.abs(Math.log2(ratios[0]) - logNorm);
      for (let j = 1; j < ratios.length; j++) {
        const d = Math.abs(Math.log2(ratios[j]) - logNorm);
        if (d < bestDist) { bestDist = d; bestRatio = ratios[j]; }
      }

      let target = fundamentalFreq * bestRatio * Math.pow(2, octave);
      if (varianceHz > 0) {
        target += (Math.random() * 2 - 1) * varianceHz;
      }
      out[i] = Math.max(0.001, Math.min(20000, target));
    }
    return out;
  }

  /**
   * Smoothly glide every oscillator's frequency to the provided targets over
   * durationMs. Uses a requestAnimationFrame tween in log2 space so the glide
   * sounds uniformly-paced musically (1 octave per equal slice of time) rather
   * than rushing through the upper registers. Cancels any prior glide so
   * back-to-back tunes behave predictably. Each frame writes via
   * setAllFrequenciesBatch so existing UI pollers pick up the motion for free.
   *
   * @param {number[]} targets       Per-osc target frequencies (Hz)
   * @param {number}   durationMs    Glide length in ms. 0 = instant.
   * @param {Function} [onComplete]  Invoked when the glide finishes or is cancelled.
   */
  glideToFrequencies(targets, durationMs = 1000, onComplete = null) {
    if (!this.isInitialized) return;
    if (this._glideRaf != null) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
    }
    const count = Math.min(targets.length, this.oscillatorCount);
    const starts = this.frequencyValues.slice(0, count);
    const safeTargets = new Array(count);
    for (let i = 0; i < count; i++) {
      safeTargets[i] = Math.max(0.001, Math.min(20000, targets[i]));
    }

    if (durationMs <= 0) {
      this.setAllFrequenciesBatch(safeTargets);
      if (onComplete) onComplete();
      return;
    }

    const logStarts = starts.map((f) => Math.log2(Math.max(0.001, f)));
    const logTargets = safeTargets.map((f) => Math.log2(f));
    const startMs = performance.now();
    // Smooth ease-in-out cubic: slow departure, fast middle, slow landing.
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const elapsed = performance.now() - startMs;
      const t = Math.min(1, elapsed / durationMs);
      const k = ease(t);
      const frame = new Array(count);
      for (let i = 0; i < count; i++) {
        frame[i] = Math.pow(2, logStarts[i] + (logTargets[i] - logStarts[i]) * k);
      }
      this.setAllFrequenciesBatch(frame);
      if (t >= 1) {
        this._glideRaf = null;
        if (onComplete) onComplete();
        return;
      }
      this._glideRaf = requestAnimationFrame(step);
    };
    this._glideRaf = requestAnimationFrame(step);
  }

  /**
   * Cancel any in-flight frequency glide without snapping to the final target.
   * Called when the user starts another interaction that conflicts with the
   * tween (e.g. dragging the "all" orb or a per-osc dot).
   */
  cancelFrequencyGlide() {
    if (this._glideRaf != null) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
    }
  }

  /**
   * Get current frequency value for an oscillator
   */
  getFrequency(index) {
    return this.frequencyValues[index] || 0;
  }
  
  /**
   * Get current volume value for an oscillator (0-1)
   */
  getVolume(index) {
    return this.volumeValues[index] || 0;
  }
  
  /**
   * Get all frequencies
   */
  getAllFrequencies() {
    return [...this.frequencyValues];
  }
  
  /**
   * Get all volumes (as percentages 0-100)
   */
  getAllVolumes() {
    return this.volumeValues.map(v => Math.round(v * 100));
  }
  
  /**
   * Get muted state for all oscillators
   */
  getAllMutedStates() {
    return [...this.mutedStates];
  }
  
  /**
   * Check if an oscillator is muted
   */
  isMuted(index) {
    return this.mutedStates[index] || false;
  }
  
  /**
   * Mute a specific oscillator with fade
   */
  muteOscillator(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;
    
    this.mutedStates[index] = true;
    this.preMuteVolumes[index] = this.volumeValues[index];
    
    const currentTime = this.audioContext.currentTime;
    const gainNode = this.gainNodes[index];
    
    gainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = gainNode.gain.value;
    gainNode.gain.setValueAtTime(Math.max(currentGain, 0.001), currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.3);
    gainNode.gain.setValueAtTime(0, currentTime + 0.3);
  }
  
  /**
   * Unmute a specific oscillator with fade
   */
  unmuteOscillator(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;
    
    this.mutedStates[index] = false;
    const targetVolume = this.volumeValues[index];
    
    const currentTime = this.audioContext.currentTime;
    const gainNode = this.gainNodes[index];
    
    gainNode.gain.cancelScheduledValues(currentTime);
    gainNode.gain.setValueAtTime(0.001, currentTime);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(targetVolume, 0.001), currentTime + 0.3);
  }
  
  /**
   * Toggle mute for a specific oscillator
   */
  toggleMute(index) {
    if (this.mutedStates[index]) {
      this.unmuteOscillator(index);
    } else {
      this.muteOscillator(index);
    }
    return this.mutedStates[index];
  }
  
  /**
   * Fade out master volume
   * @returns {Promise} Resolves when fade is complete
   */
  fadeOut() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.3; // 300ms fade
    const currentTime = this.audioContext.currentTime;
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = this.masterGainNode.gain.value;
    this.masterGainNode.gain.setValueAtTime(Math.max(currentGain, 0.001), currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + fadeDuration);
    this.masterGainNode.gain.setValueAtTime(0, currentTime + fadeDuration);
    
    this.isPaused = true;
    
    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Fade in master volume
   * @returns {Promise} Resolves when fade is complete
   */
  fadeIn() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.5; // 500ms fade
    const currentTime = this.audioContext.currentTime;
    const targetGain = this._getScaledMasterGain();
    
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    this.masterGainNode.gain.setValueAtTime(0.001, currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(targetGain, currentTime + fadeDuration);
    
    this.isPaused = false;
    
    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    if (!this.isInitialized) return;
    
    if (this.isPaused) {
      this.fadeIn();
    } else {
      this.fadeOut();
    }
    
    return this.isPaused;
  }
  
  /**
   * Advance per-oscillator phase accumulators to audioContext.currentTime.
   * Call once per visualizer frame. Each phase integrates an
   * exponentially-smoothed target frequency whose smoothing tau mirrors
   * setFrequency's setTargetAtTime(freq, now, 0.016), so the accumulated
   * phase tracks the actual running Web Audio oscillators — including
   * across slider drags where the audio graph is ramping the frequency.
   */
  updatePhases() {
    if (!this.isInitialized || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    const TWO_PI = Math.PI * 2;
    const tau = this._phaseSmoothTau;
    for (let i = 0; i < this.oscillatorCount; i++) {
      const last = this._lastPhaseUpdate[i];
      if (last === null || last === undefined) {
        this._lastPhaseUpdate[i] = now;
        continue;
      }
      const dt = now - last;
      if (dt <= 0) continue;
      this._lastPhaseUpdate[i] = now;
      const alpha = 1 - Math.exp(-dt / tau);
      const target = this.frequencyValues[i] || 0;
      if (this.smoothedFreqs[i] === undefined) {
        this.smoothedFreqs[i] = target;
      } else {
        this.smoothedFreqs[i] += (target - this.smoothedFreqs[i]) * alpha;
      }
      this.phases[i] =
        ((this.phases[i] || 0) + TWO_PI * this.smoothedFreqs[i] * dt) % TWO_PI;
    }
  }

  /**
   * Get the current accumulated phase (radians, 0..2π) for one oscillator.
   */
  getPhase(index) {
    return this.phases[index] || 0;
  }

  /**
   * Get current accumulated phases (radians, 0..2π) for all oscillators.
   */
  getAllPhases() {
    return [...this.phases];
  }

  /**
   * Measure each oscillator's current phase directly from the analyzer
   * time-domain buffers and overwrite the phase accumulator with the
   * measured value. Called once per visualizer frame (after
   * updatePhases) so phases[] stays locked to what the audio graph is
   * actually producing.
   *
   * Signal model per analyzer channel:
   *   x[s] = Σ_k [ c_k · sin(ω_k·s) + d_k · cos(ω_k·s) ]
   * where (c_k, d_k) = (A_k·cos θ_k, A_k·sin θ_k). Since all ω_k are
   * known, x = M·p is linear in the 2M unknowns p = [c_0,d_0,c_1,d_1,…];
   * we solve the normal equations M^T M · p = M^T x jointly across all
   * oscillators routed to the channel. This is the right approach (vs.
   * per-osc Goertzel) because it EXACTLY accounts for the mutual
   * leakage between oscillators whose frequencies are within the
   * Goertzel bin width — e.g. two oscs 1 Hz apart that beat together.
   *
   * Implementation:
   * • M^T M has a closed-form expression via the Dirichlet kernel
   *   (_sumCos / _sumSin below), so we build it in O(K²) rather than
   *   O(K²N). It depends only on frequencies + routing, so we cache the
   *   Cholesky factor across frames, keyed by a routing+frequency
   *   signature. Recomputed automatically when anything changes.
   * • M^T x requires one pass over the analyzer buffer per oscillator:
   *   O(K·N) per channel per frame, done via sin/cos rotation recurrence.
   * • After solving, θ_k = atan2(d_k, c_k) gives phase at sample 0;
   *   we extrapolate by ω·(N−1) to land on phases[k]'s "phase at
   *   currentTime" convention.
   *
   * Oscillators routed only to output channels > 1 (not visible on
   * analyzers 0/1) are skipped — their phases fall back to
   * updatePhases()'s accumulator.
   */
  calibratePhases() {
    if (!this.isInitialized || !this.audioContext) return;
    const L = this.getTimeDataLeft();
    const R = this.getTimeDataRight();
    if (!L || !R) return;
    const sampleRate = this.audioContext.sampleRate;
    this._calibrateChannel(L, sampleRate, 0);
    this._calibrateChannel(R, sampleRate, 1);
  }

  _calibrateChannel(signal, sampleRate, channel) {
    const N = signal.length;
    const TWO_PI = Math.PI * 2;

    // Gather oscillators routed to this analyzer channel. Use
    // smoothedFreqs (maintained by updatePhases with the same 0.016 s
    // exponential tau Web Audio's setTargetAtTime uses internally)
    // rather than frequencyValues (which is the LATEST scheduled
    // target). During a glide or slider drag the audio buffer the LSQ
    // is fitting contains the smoothed frequency, not the target —
    // using smoothedFreqs keeps the LSQ basis aligned with the signal.
    // At steady state the two are equal.
    const oscs = [];
    for (let k = 0; k < this.oscillatorCount; k++) {
      const f = this.smoothedFreqs[k];
      if (!(f > 0)) continue;
      const ch = this.routingMap[k] || [];
      if (ch.includes(channel)) oscs.push({ k, f });
    }
    const M = oscs.length;
    if (M === 0) return;
    const P = 2 * M;

    // Cache signature: invalidate on any change to the osc set, their
    // frequencies, or the analyzer buffer length.
    let sig = N + '|';
    for (let i = 0; i < M; i++) sig += oscs[i].k + ':' + oscs[i].f.toFixed(6) + ';';

    const cacheKey = channel === 0 ? '_lsqCacheL' : '_lsqCacheR';
    let cache = this[cacheKey];

    if (!cache || cache.sig !== sig) {
      // Build M^T M analytically. Block (i, j) is a 2×2 of the inner
      // products [[<sin_i,sin_j>, <sin_i,cos_j>], [<cos_i,sin_j>,
      // <cos_i,cos_j>]], each reducible via product-to-sum to
      // combinations of _sumCos / _sumSin at (ω_i ± ω_j).
      const MtM = new Float64Array(P * P);
      for (let i = 0; i < M; i++) {
        const wi = TWO_PI * oscs[i].f / sampleRate;
        for (let j = 0; j <= i; j++) {
          const wj = TWO_PI * oscs[j].f / sampleRate;
          const cp = _sumCos(wi + wj, N);
          const cm = _sumCos(wi - wj, N);
          const sp = _sumSin(wi + wj, N);
          const sm = _sumSin(wi - wj, N);
          const ss = (cm - cp) / 2; // <sin_i, sin_j>
          const sc = (sp + sm) / 2; // <sin_i, cos_j>
          const cs = (sp - sm) / 2; // <cos_i, sin_j>
          const cc = (cm + cp) / 2; // <cos_i, cos_j>
          const r0 = 2 * i, r1 = 2 * i + 1;
          const c0 = 2 * j, c1 = 2 * j + 1;
          MtM[r0 * P + c0] = ss;
          MtM[r0 * P + c1] = sc;
          MtM[r1 * P + c0] = cs;
          MtM[r1 * P + c1] = cc;
          if (i !== j) {
            // Mirror to symmetric partner.
            MtM[c0 * P + r0] = ss;
            MtM[c1 * P + r0] = sc;
            MtM[c0 * P + r1] = cs;
            MtM[c1 * P + r1] = cc;
          }
        }
      }

      // Tikhonov regularization — keeps Cholesky well-defined when two
      // oscillators are at nearly identical frequencies (the columns
      // become linearly dependent). 1e-9 × trace is far below the
      // signal level so well-conditioned cases are unaffected.
      let trace = 0;
      for (let d = 0; d < P; d++) trace += MtM[d * P + d];
      const lambda = Math.max(1e-12, 1e-9 * trace);
      for (let d = 0; d < P; d++) MtM[d * P + d] += lambda;

      if (!_choleskyInPlace(MtM, P)) {
        // Factorization failed despite regularization — bail, leaving
        // phases[] as whatever updatePhases produced.
        return;
      }
      cache = { sig, oscs, LL: MtM, P, N };
      this[cacheKey] = cache;
    }

    // Build M^T x for the current signal: each pair of entries is
    // (Σ x[s]·sin(ω_i·s), Σ x[s]·cos(ω_i·s)).
    const Mtx = new Float64Array(P);
    for (let i = 0; i < M; i++) {
      const omega = TWO_PI * cache.oscs[i].f / sampleRate;
      const cosStep = Math.cos(omega);
      const sinStep = Math.sin(omega);
      let cosT = 1, sinT = 0;
      let sinSum = 0, cosSum = 0;
      for (let s = 0; s < N; s++) {
        sinSum += signal[s] * sinT;
        cosSum += signal[s] * cosT;
        const nc = cosT * cosStep - sinT * sinStep;
        const ns = sinT * cosStep + cosT * sinStep;
        cosT = nc;
        sinT = ns;
      }
      Mtx[2 * i] = sinSum;
      Mtx[2 * i + 1] = cosSum;
    }

    const p = _choleskySolve(cache.LL, Mtx, P);

    // Extract phases. Model: x[s] = c·sin(ωs) + d·cos(ωs) = A·sin(ωs+θ)
    // with c = A·cos(θ), d = A·sin(θ), so θ = atan2(d, c).
    //
    // BUT during an active tune glide / slider drag / fade-in, each
    // oscillator's frequency is sweeping across the 186 ms analyzer
    // buffer while the LSQ basis is fixed at a single freq per
    // oscillator. The projection magnitudes √(c²+d²) collapse toward
    // zero (chirp doesn't correlate well with a fixed sinusoid) and
    // atan2 returns near-random phase — which makes the synth XY look
    // like it "disappears" because each frame's Lissajous is a
    // different rotation and fade persistence washes them out.
    //
    // Compare the LSQ-recovered amplitude A_lsq = √(c²+d²)·(2/N) to
    // what we expect from the user's volume + master scale. At steady
    // state the ratio is ~1 and we snap to LSQ. During a sweep the
    // ratio collapses toward 0 and we stay on updatePhases()'s
    // accumulator, which integrates smoothedFreqs (matching Web
    // Audio's internal setTargetAtTime tau) and therefore stays
    // coherent during non-stationary periods. Blend continuously
    // through the middle so the handoff is smooth — no thresholds.
    const masterScale = this._getScaledMasterGain();
    const twoOverN = 2 / N;
    for (let i = 0; i < M; i++) {
      const oscIdx = cache.oscs[i].k;
      const c = p[2 * i];
      const d = p[2 * i + 1];
      const aLsq = Math.sqrt(c * c + d * d) * twoOverN;
      const muted = this.mutedStates[oscIdx];
      const aExpected = (muted ? 0 : (this.volumeValues[oscIdx] || 0)) * masterScale;
      const confidence = aExpected > 1e-6 ? Math.min(1, aLsq / aExpected) : 0;
      if (confidence < 1e-3) continue; // accumulator owns it this frame

      const thetaAt0 = Math.atan2(d, c);
      const omega = TWO_PI * cache.oscs[i].f / sampleRate;
      const phaseAtEnd = thetaAt0 + omega * (N - 1);
      const phaseLsq = ((phaseAtEnd % TWO_PI) + TWO_PI) % TWO_PI;
      const phaseAcc = this.phases[oscIdx] || 0;
      // Shortest signed arc from accumulator toward LSQ, in (−π, π].
      // Scale by confidence so partial trust moves phase only partway.
      // Additionally cap the blend rate at MAX_BLEND so LSQ's
      // frame-to-frame measurement noise (driven by analyzer-quantum vs
      // rAF-frame timing jitter, which can be up to ±1 rad at 100 Hz)
      // gets averaged across ~1/alpha frames instead of pushing a
      // different value into the renderer each tick. The accumulator
      // still advances at the true rate in updatePhases(), so capping
      // only slows the LSQ *correction* — not the tracking of an actual
      // phase change. Effective tracking lag when LSQ is steady is
      // ~1/alpha frames ≈ 5 frames ≈ 83 ms, well under one beat cycle.
      let delta = phaseLsq - phaseAcc;
      delta = ((delta + 3 * Math.PI) % TWO_PI) - Math.PI;
      const MAX_BLEND = 0.2;
      const blend = Math.min(confidence, MAX_BLEND);
      let next = phaseAcc + blend * delta;
      next = ((next % TWO_PI) + TWO_PI) % TWO_PI;
      this.phases[oscIdx] = next;
    }
  }

  /**
   * Get time domain data for visualization (left channel)
   */
  getTimeDataLeft() {
    if (!this.isInitialized) return null;
    
    this.analyserNode1.getFloatTimeDomainData(this.timeData1);
    return this.timeData1;
  }
  
  /**
   * Get time domain data for visualization (right channel)
   */
  getTimeDataRight() {
    if (!this.isInitialized) return null;
    
    this.analyserNode2.getFloatTimeDomainData(this.timeData2);
    return this.timeData2;
  }
  
  /**
   * Check if audio is initialized
   */
  get initialized() {
    return this.isInitialized;
  }
  
  /**
   * Check if audio is paused
   */
  get paused() {
    return this.isPaused;
  }
}

// ── Helpers for calibratePhases (joint least-squares phase recovery) ─────

// Σ_{s=0}^{N−1} cos(ω·s) via the Dirichlet-kernel identity:
//   sum = cos((N−1)·ω/2) · sin(N·ω/2) / sin(ω/2)
// Degenerate when sin(ω/2) ≈ 0 (ω is an integer multiple of 2π): every
// term is 1, so the sum is exactly N.
function _sumCos(omega, N) {
  const half = omega / 2;
  const s = Math.sin(half);
  if (Math.abs(s) < 1e-12) return N;
  return Math.cos((N - 1) * half) * Math.sin(N * half) / s;
}

// Σ_{s=0}^{N−1} sin(ω·s). Same identity; degenerate case is 0.
function _sumSin(omega, N) {
  const half = omega / 2;
  const s = Math.sin(half);
  if (Math.abs(s) < 1e-12) return 0;
  return Math.sin((N - 1) * half) * Math.sin(N * half) / s;
}

// In-place Cholesky factorization of a symmetric positive-definite
// n×n matrix A (row-major Float64Array). Writes the lower-triangular
// factor L into the lower triangle of A (the upper triangle is ignored
// by the solve). Returns true on success, false if A turns out not to
// be positive-definite (a diagonal term goes non-positive). Callers
// should regularize the diagonal before calling to avoid that path.
function _choleskyInPlace(A, n) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= A[i * n + k] * A[j * n + k];
      }
      if (i === j) {
        if (sum <= 0) return false;
        A[i * n + j] = Math.sqrt(sum);
      } else {
        A[i * n + j] = sum / A[j * n + j];
      }
    }
  }
  return true;
}

// Solve L·L^T·x = b, where L is the lower-triangle Cholesky factor
// produced by _choleskyInPlace. Does forward substitution (L·y = b)
// then backward substitution (L^T·x = y); returns x as a fresh
// Float64Array of length n.
function _choleskySolve(L, b, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

// Export singleton instance
const audioEngine = new AudioEngine();
export default audioEngine;
